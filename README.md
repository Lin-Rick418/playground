# Baccarat Platform

Vue 3 + Pinia 前端，Node.js + Express 後端，PostgreSQL 資料庫。

## 功能

- 玩家登入
- 百家樂自動輪局、封盤、開牌、結算
- 玩家歷史下注紀錄
- Admin 登入
- Admin 查詢玩家列表
- Admin 手動調整玩家餘額
- 最近餘額異動紀錄

## 開發用預設帳號

執行 `npm run db:seed` 後才會建立：
- `admin / admin123`
- `player1 / player123`

## 開發

```bash
npm install
npm run dev:db
npm run db:seed
npm run dev:all
```

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
npm run dev:web
```

然後把前端 port (`5173`) 做 forwarded port 給別人即可。

如果你之後要分開部署，也可以在 `apps/web/.env` 設定：

```bash
VITE_API_BASE_URL=https://your-api-host.example.com
```

預設範例可參考 [apps/web/.env.example](/Users/k/Documents/Playground/apps/web/.env.example)。

## 技術選擇

- 前端: Vue 3, Pinia, Vue Router, Vite
- 後端: Node.js, Express, JWT, WebSocket
- 資料庫: PostgreSQL

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

## 備註

- 目前是測試幣模式，未接金流。
- 牌局會持續自動進行，即使沒有玩家下注也會照常輪轉。
- 後端目前拆成兩個常駐進程：
  - `api server`
  - `round worker`
- 桌況同步改成 WebSocket snapshot 推送，前端不再依賴收到事件後整包 refresh。
- 正式環境啟動時不會自動建立 demo 帳號；若要開發測試帳號，請手動執行 `npm run db:seed`。
- 若未來要多人同步牌桌、路單分析、會員管理、操作審計，可在此基礎擴充。
