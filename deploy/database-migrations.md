# Database Migration Runbook

本專案使用有順序、不可變的 PostgreSQL migration。只有明確執行 `npm run db:migrate` 才會進行 DDL；API、worker、bootstrap、seed 只檢查 schema 是否為目前版本，不會自行修改 schema。

## 日常指令

```bash
npm run db:migrate:status
npm run db:migrate
npm run db:migrate:status
```

- `db:migrate` 以 PostgreSQL advisory lock 序列化 runner，避免兩個部署同時套用 migration。
- 每一個 migration 各自在 transaction 中執行；失敗時該 migration 的 DDL 與紀錄會一起 rollback。
- `schema_migrations` 保存 `version`、`name`、SHA-256 checksum 與套用時間。
- `db:migrate:status` 在尚有 pending migration 時使用非零 exit code，可作為 deployment gate。
- runner 會拒絕未知版本、缺少中間版本、名稱變更與 checksum drift。

## 新增 migration

1. 在 `apps/server/src/migrations/` 加入下一個連續版本，並登錄於 `index.ts`。
2. migration 必須可在目標 PostgreSQL 版本的一個 transaction 中完成。
3. 已在任何環境套用的 migration 不得修改、重新排序或刪除；修正必須新增下一個 migration。
4. schema 與應用程式跨版本相容時採 expand-contract：先新增並雙讀/雙寫，待舊版程式完全下線後，才在後續 release 移除舊欄位或 constraint。
5. 在獨立空資料庫執行 `npm run test:migrations-db --workspace server`，並驗證既有資料庫升級路徑。

## Production deployment 順序

1. 確認最新可還原的 `pg_dump`，並記錄目前 application commit 與 migration version。
2. 停止 API 與 worker，避免尚未驗證相容性的舊程式在 schema 變更時持續寫入。
3. 安裝與 build 新版本。
4. 載入 production env，執行 `npm run db:migrate`。
5. 執行 `npm run db:migrate:status`；只有顯示 current 且 exit code 為 0 才能繼續。
6. 首次部署執行 `npm run db:bootstrap` 建立必要桌別與牌靴；如部署明確需要 seed，也必須在 migration 成功後才執行。
7. 啟動 worker 與 API，檢查 health、startup log 與核心讀寫流程。

本次既有 migration 都是 additive，舊版程式可容忍新增欄位與 index；新版程式則會拒絕未 migration 的舊 schema。即使如此，預設 runbook 仍停止兩個服務後再 migrate，除非該次 release 已明確驗證 rolling deployment 相容性。

## 失敗與 rollback

- migration command 失敗：不要啟動新服務。該 migration 的 transaction 已 rollback；修正 migration SQL 或環境問題後重試。不要手動插入或刪除 `schema_migrations`。
- migration 成功、application 驗證失敗：本次 migration 為 additive 時，可先回退 application commit，保留新 schema，再修復並重新部署。
- destructive 或不相容 migration：必須在變更前提供獨立的資料回填、驗證與復原計畫。優先新增 corrective forward migration；只有在資料已受損且 forward fix 不可行時，才停機並從已驗證的 backup 還原。
- 不提供自動 `down` migration，因為反向 DDL 可能遺失資料且無法保證交易安全。任何 rollback 都必須以該 migration 的資料影響為基礎決策。

## 手動檢查

```sql
SELECT version, name, checksum, applied_at
FROM schema_migrations
ORDER BY version;
```

若 status 回報 checksum drift 或 out-of-order history，將資料庫視為需人工處理的異常狀態；先比對部署 artifact 與資料庫來源，不得直接改 history 來繞過檢查。
