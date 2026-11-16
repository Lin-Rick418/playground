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

## Blackjack（migration 14）

1. 備份資料庫、停止 API／worker 寫入，維持 `BLACKJACK_ENABLED=false`。
2. 使用新版執行 `npm run db:migrate`，新增牌局／操作資料、唯一 ACTIVE 索引及 ledger 來源；既有資料保留。
3. 執行 `npm run db:migrate:status`，確認 14/14 與 schema fingerprint 正確，再啟動新版服務及 web。
4. 驗證新局、分牌／加倍／保險追加投注、失聯重播、每日損益、跨遊戲曝險與 `financial_balance_reconciliation`，再明確設定 `BLACKJACK_ENABLED=true`。

停用旗標只拒絕新局；讀取、既有局操作與 idempotency replay 繼續提供。存在 ACTIVE Blackjack 時不得回退到不含 Blackjack 曝險的 server；保留新版 schema、結算能力、ledger 與永久 idempotency，採向前修復。無自動 down migration。

## 沙海神殿（migration 15）

新增 `storm_sessions`／`storm_rounds`、不可變局紀錄 trigger、ledger 來源與索引；共用曝險與每日損益納入 Storm。範例 `STORM_ENABLED=false`，完成隔離驗收後明確開啟。

先備份並停止 API／worker，使用新版執行 `db:migrate`、確認 `db:migrate:status` 為 15/15，再啟動服務。一般帳戶與既有交易保留。已發出的免費回合可在關閉旗標後繼續結算，原 key replay 永久可用。

有剩餘免費回合時不可回退到不計 Storm 曝險的舊程式；關閉新投注並保留 schema、ledger、idempotency 與結算能力，向前修復。不要刪除免費進度、重新套用舊 migration 或改寫 migration history。完整 API 與規則見 [沙海神殿](../docs/storm-demo.md)。

## 沙海神殿可配置 RTP（migration 16／17）

16 新增不可變配率 profile、發布紀錄與 active pointer；17 加入完整 `settings`、每轉／整段 cap 與免費系列上限，並用 session composite FK 和曝險 CHECK 綁定原始 profile。migration 保留既有 v1/v2 與 active pointer，不會自動發布草稿。

先備份、停止舊版 API／worker，再執行 `db:migrate`，確認 `db:migrate:status` 為 17/17 後啟動新版。後台需先 build 平台 contracts，且使用相同 DB 與 source root。免費系列持續依原 profile 結算；禁止回退不理解 v3 或 Storm 曝險的 server。停止新局採 `STORM_ENABLED=false`，保留免費結算與 replay。詳見 [RTP 操作與驗證](../docs/storm-rtp-control.md)。

## 沙海神殿高／低 RTP（migration 18）

18 擴大 `target_rtp` 精度與 v3 的派彩係數範圍，支援零 RTP 與超過 100% 的目標；舊 v2 仍保留原範圍，profile、publication 與 active pointer 不改寫。依同一備份／停止服務／migrate／確認 18/18／啟動流程部署。不要重寫 migration 16 或 17；新目標需重新校準與確認發布。無法達成的參數組合保持草稿，不會變更玩家配率。

## 沙海神殿投注級距（migration 19）

19 擴充 `storm_sessions.amount` 與 `storm_rounds.stake` 的 CHECK，支援 10／50／100／200／500／1000／2000／5000，並保留舊 20 幣資料與請求。免費累計派彩欄位上限對齊 money contract 的 20 億；原本 session 曝險、profile 上限與 round 派彩 CHECK 保留，不改寫任何交易或 math profile。

依備份／停止 API 與 worker／`db:migrate`／確認 `db:migrate:status` 為 19/19／啟動新版服務與 web 的順序部署。產生新級距交易後，不可直接回退至只接受舊四個金額的 server 或 contracts；暫停新付費局使用 `STORM_ENABLED=false`，保留已發出免費回合與原 key replay。新選單不代表繞過曝險上限，舊 v1 的大額投注限制詳見 [沙海神殿](../docs/storm-demo.md)。
