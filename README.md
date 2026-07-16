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

## 首次建立 Admin

專案不提供預設帳號。第一次啟動前，請明確設定一次性 bootstrap credentials：

```bash
touch .bootstrap-admin.env
chmod 600 .bootstrap-admin.env
${EDITOR:-vi} .bootstrap-admin.env
NODE_ENV=development BOOTSTRAP_ADMIN_CREDENTIALS_FILE=.bootstrap-admin.env npm run admin:bootstrap
rm -f .bootstrap-admin.env
```

檔案內容格式：

```dotenv
BOOTSTRAP_ADMIN_USERNAME=your_admin_username
BOOTSTRAP_ADMIN_PASSWORD=a-unique-password-of-at-least-16-characters
```

`admin:bootstrap` 只會在資料庫完全沒有 Admin 時建立一個帳號；既有 Admin 存在時會拒絕執行，也不會建立預設 Player。credential file 必須是 `0600`（或更嚴格），且已由 `.gitignore` 排除。請使用 password manager 產生並保存唯一密碼，成功後立即刪除檔案。

## 開發

```bash
npm install
npm run dev:db
# 依照上方步驟執行一次 npm run admin:bootstrap
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

## 備註

- 目前是測試幣模式，未接金流。
- 牌局會持續自動進行，即使沒有玩家下注也會照常輪轉。
- 後端目前拆成兩個常駐進程：
  - `api server`
  - `round worker`
- 桌況同步改成 WebSocket snapshot 推送，前端不再依賴收到事件後整包 refresh。
- 所有環境都不會自動建立 demo 帳號；Player 必須由 Admin 登入後明確建立。
- 若未來要多人同步牌桌、路單分析、會員管理、操作審計，可在此基礎擴充。
