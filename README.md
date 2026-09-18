# Baccarat Platform

Vue 3 + Pinia 前端，Node.js + Express 後端，PostgreSQL 資料庫。

AI 開發指引請先閱讀 [AGENTS.md](AGENTS.md)；Claude 使用相同指引。

## 功能

- 玩家登入後選擇百家樂、Mines、Plinko 或 Hi-Lo，四款遊戲共用錢包
- Mines：5×5、新局 3–24 顆雷，投注 100–5,000（每次遞增 100），公式 RTP 95%
- 後端保留兩位小數，畫面金額隱藏小數且不進位
- 玩家登入
- 百家樂自動輪局、封盤、開牌、結算
- 玩家歷史下注紀錄
- 玩家本日收益與帳號密碼管理
- WebSocket 即時桌況與可驗證牌靴公平性

## 開發用預設帳號

執行 `npm run db:seed` 後才會建立：

- `player1 / LuckyShoes!2026`

已存在的開發資料不會自動覆寫密碼；若資料庫曾建立舊帳號，請由帳號安全頁更新。

## 開發

```bash
nvm use
npm ci
cp apps/server/.env.example apps/server/.env
npm run dev:db
npm run db:migrate
npm run db:bootstrap
npm run db:seed
npm run dev:all
```

`cp` 僅在第一次建立本機環境、尚無 `apps/server/.env` 時執行，避免覆蓋既有設定。
資料庫指令會讀取該檔案中的 `NODE_ENV=development`；缺少時會採用 production 的 JWT secret 檢查。
拉取含 migration 的更新後，先停止 API／worker，執行 `npm run db:migrate`，再以 `npm run dev:all` 啟動。
若看到 `Database schema is at version …, expected …`，表示尚未執行 migration，前端此時也會因 API 未啟動而顯示 proxy 連線錯誤。

- 前端: `http://localhost:5173`
- 後端 HTTP / WS: `http://localhost:4000`

如果你只想先把 PostgreSQL 拉起來：

```bash
npm run dev:db
```

結束後可用：

```bash
npm run dev:db:down
```

## 對外分享 / Forwarded Port

如果你要讓別人透過 forwarded port 直接使用，請分享前端那個 URL，不要讓前端直接打 `localhost:4000`。

目前前端預設會：

- 直接呼叫 `/api`
- 由 Vite dev server 代理到 `http://127.0.0.1:4000`

所以開發時只要同時啟動：

```bash
npm run dev:server
npm run dev:worker
npm run dev:web
```

然後把前端 port (`5173`) 做 forwarded port 給別人即可。

如果你之後要分開部署，也可以在 `apps/web/.env` 設定：

```bash
VITE_API_BASE_URL=https://your-api-host.example.com
```

預設範例可參考 [apps/web/.env.example](apps/web/.env.example)。

## 技術選擇

- 前端: Vue 3, Pinia, Vue Router, Vite
- 後端: Node.js, Express, JWT, WebSocket
- 資料庫: PostgreSQL

本專案固定使用 Node `22.19.0` 與 npm `10.9.3`；`.nvmrc`、`.node-version`、`packageManager`、`engines` 與 install preflight 會共同拒絕版本漂移。build 後可由前端 `/build-metadata.json` 及 API `/api/build-metadata` 核對 commit/runtime metadata。

## 金額異動 API 的 idempotency

下注請求必須帶 8–128 字元的 `Idempotency-Key` header。client 在回應不確定時，應以相同 key 與完全相同的 payload 重試；server 會回傳第一次已提交的結果，而不會再次扣款。同一使用者、同一操作範圍若以相同 key 傳送不同 payload，server 會回傳 `409`。

此 repository 僅提供 player app；admin 頁面、API 與登入權限已移除。既有 admin／adjustment／ledger 資料仍保留，供未來獨立後台承接。

## API error contract

所有 HTTP API errors 都使用 JSON，並保留既有的 top-level `message` 欄位：

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Invalid payload",
  "requestId": "3d1334d8-cb00-4cd7-b614-3c66ec67babc"
}
```

每個 response 都會回傳 `X-Request-Id` header，內容與 error body 的 `requestId` 相同。Client 可傳入 1–128 字元、僅包含英數與 `._:-` 的 `X-Request-Id`；不符合格式時 server 會改用 UUID。回報 API 問題時應附上此 ID，以便對應 server structured error log。Unknown routes 與 malformed JSON 也遵循同一 contract，不會回傳 Express HTML 或 internal error details。

## CI

Pull request 的 required checks、本機驗證指令與 integration test database 注意事項請見
[docs/ci.md](docs/ci.md)。

## 公平性稽核

每個新 shoe 會先發布 cryptographic commitment，rotate 後 reveal seed 與 append-only deal audit，讓玩家或 operator 可獨立重建驗證。algorithm、API、verifier 與 threat model 見 [docs/shoe-audit.md](docs/shoe-audit.md)。

## 備註

- 目前是測試幣模式，未接金流。
- 牌局會持續自動進行，即使沒有玩家下注也會照常輪轉。
- 後端目前拆成兩個常駐進程：
  - `api server`
  - `round worker`
- 桌況同步改成 WebSocket snapshot 推送，前端不再依賴收到事件後整包 refresh。
- WebSocket server 限制 8 KiB message、每個 user/IP 的連線數與 message/upgrade rate，並以 heartbeat 清除失效連線；反向代理不得放寬到比 application 更寬鬆的 payload/connection policy。
- 正式環境啟動時不會自動建立 demo 帳號；若要開發測試帳號，請手動執行 `npm run db:seed`。
- API、worker、bootstrap 與 seed 都不會自動執行 DDL；第一次啟動及拉取新版本後，必須先執行 `npm run db:migrate`。
- 第一次建立環境時，執行 `npm run db:bootstrap` 建立必要桌別與牌靴；`db:seed` 另外加入開發用 demo 帳號。
- 可用 `npm run db:migrate:status` 檢查目前版本；schema 落後時會回傳非零 exit code。
- 正式環境的 migration 順序、相容性與 rollback 策略請見 [deploy/database-migrations.md](deploy/database-migrations.md)。
- 若未來要多人同步牌桌、路單分析、會員管理、操作審計，可在此基礎擴充。

## Mines 與金額精度

玩法、API、重試及精度規則見 [docs/mines.md](docs/mines.md)。升級需先依 [migration runbook](deploy/database-migrations.md) 停止 API／worker 並執行 migration 10。`MINES_ENABLED=false` 可停止新局，既有局仍可翻格及收款。

## Plinko

新增 `/plinko`：8–16 排、低／中／高風險，每球 100–5,000 測試幣，共用錢包。27 組倍率各自縮放至約 **95.5% RTP**；抽選、扣款與派彩由後端一次提交，前端只播放落球路徑。完整規則、API、精度與重試方式見 [docs/plinko.md](docs/plinko.md)。需先執行 migration 11；`PLINKO_ENABLED=false` 停止新投注，已提交結果仍可查回。

## Casino PWA

玩家端可安裝為 Casino，登入頁與大廳提供安裝入口。僅在瀏覽器提供安裝事件時顯示安裝按鈕，不顯示安裝教學。從主畫面啟動時使用 standalone 模式隱藏網址列；一般瀏覽器分頁仍保留瀏覽器介面。

Manifest 在開發模式與 production 共用，讓 forwarded port 也具備相同的 standalone／scope 設定。Service Worker 與離線功能僅在 production build 啟用，正式環境需要 HTTPS（localhost 可用於開發驗證）。首次成功連線並完成 Service Worker 安裝後，離線開啟會顯示獨立提示頁；遊戲、登入與帳戶資料仍需要網路。

```bash
npm run build --workspace web
npm run preview --workspace web
# 獨立 production preview 測試，包含兩個 build 的版本交接，不需要資料庫
npm run test:pwa
```

一般 `npm run dev:web` 不註冊 Service Worker。若曾在同一 origin 測試 production，請先在 DevTools → Application → Service Workers 取消註冊，再清除 `casino-pwa-offline` cache，避免殘留註冊影響開發。

部署、更新與 rollback 詳見 [PWA 操作說明](deploy/README.md#casino-pwa)。

## Hi-Lo

新增 `/hilo`，支援下注前換牌、連續猜大小／相同、52 次免費跳牌與收款。整局 RTP **94%**，最高 **10,000×**，共用現有測試幣錢包。需執行 migration 12；`HILO_ENABLED` 預設 false，驗收後明確設為 true。完整規則與 API 見 [docs/hilo.md](docs/hilo.md)。
