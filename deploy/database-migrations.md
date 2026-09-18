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
- migration history 顯示 current 時，runner 仍會比對 live tables、columns、constraints、indexes、triggers 與 reconciliation view 的 schema fingerprint；缺漏或型別漂移會 fail closed。
- 對沒有 `schema_migrations` 的既有資料庫，只允許在五個 legacy core tables 全部存在且核心 column fingerprint 相容時進行受控 adoption；partial 或型別不相容的 unmanaged schema 會在建立 history 前被拒絕。

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

本次 migration 會新增 constraints、immutable triggers、ledger backfill 與 shoe audit schema；必須依上述順序停機、備份、migrate、驗證後再啟動，不支援直接 rolling upgrade。新版程式會拒絕 pending migration、history drift 與 live schema fingerprint drift。

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


## Migration 10：Mines 與兩位小數錢包

此版本不是僅新增欄位，必須安排維護時段，停止 API／worker 寫入、完成備份、build、migrate，再一起更新前端並要求既有分頁重新載入。不要讓舊版整數 client 連到新版小數 API。

- 金額改為 `NUMERIC(20,2)`，原本 100 幣仍為 100.00 幣，沒有單位倍率轉換。
- Migration 在同一 transaction 內重建 balance trigger 與 reconciliation view；ledger 原有紀錄與唯一約束保留。
- `users.balance_version` 由最後一筆 ledger sequence 回填，之後隨金額異動更新，供 client 丟棄舊餘額。
- 部署後檢查 `SELECT * FROM financial_balance_reconciliation WHERE NOT is_reconciled;`。正常應為空；並驗證登入、100 幣投注、Mines 收款、小數餘額切換百家樂及 history/daily-profit。
- `MINES_ENABLED=false` 並重新啟動 API 可停止新局。讀取、續玩與收款仍可用，worker 不需要替 Mines 計時結算。
- 產生小數交易後不能回退至舊版整數程式或將欄位改回 integer。優先停止新局，保留結算服務並採向前修復；不要透過捨去小數或刪除帳本回退。
- Mines 的 idempotency keys 與遊戲紀錄持續保留，不受百家樂 retry metadata 的七日清理影響，避免長期保留局的重試變成新下注。

## Plinko（migration 11）

1. 保留現有 database 備份，停止 API／worker，避免混用 schema 版本。
2. 以新版程式執行 `npm run db:migrate`，新增 `plinko_rounds`、歷史索引，擴充 ledger source/reference 與 per-user rate-limit scope；既有帳戶、Mines 及百家樂資料均保留。
3. 執行 `npm run db:migrate:status`，確認 schema 為 11，再啟動 API／worker 與新版 frontend。
4. 驗證 `/api/plinko/config` 的 27 組倍率、RTP 95%–96%、新局、歷史與 walletVersion，同時檢查 `financial_balance_reconciliation`。

停止新投注可設定 `PLINKO_ENABLED=false` 並重啟 API；已提交請求的 idempotency replay 與歷史查詢繼續可用。若上線後需止血，保留新版 schema 與程式、關閉旗標，再 forward-fix。舊版程式的精確 schema fingerprint 不相容，不可直接回退 binary 或刪除 Plinko／ledger／idempotency 資料。Plinko 的 idempotency keys 永久保留，不可套用一般七日 retention。

## Hi-Lo（migration 12）

1. 備份並停止 API／worker 寫入；設定 `HILO_ENABLED=false`。舊版精確 schema fingerprint 與新版 schema 不相容，勿混用程序版本。
2. 使用新版執行 `npm run db:migrate`，新增 hilo_previews／hilo_rounds／hilo_round_steps 及 ledger 來源。`npm run db:migrate:status` 應顯示版本 12。
3. 啟動新版 API／worker，再部署 web。既有測試幣、其他遊戲資料與 ledger 保留。
4. 完成隔離資料庫及瀏覽器驗收，確認 reconciliation 無差異後，設定 `HILO_ENABLED=true` 並重啟 API 接受新局。
5. 觀察 hilo_command_completed／failed、結算 RTP 與 ledger 對帳。RTP 是長期理論值，不以短期數據調整 RNG。

回退優先設定 `HILO_ENABLED=false` 停止新局，保留新版 server、schema 與既有局結算能力。不可刪除牌局、ledger 或永久 idempotency；尤其有 ACTIVE 局時，不得回退至不計 Hi-Lo 曝險的舊 server。免費 preview 的 hilo-preview scope 可依一般 retention 清理，hilo.mutation 必須永久保留。
