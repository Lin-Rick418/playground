# Single-Server Deployment

這份配置假設：

- 作業系統：Ubuntu / Debian
- 部署目錄：`/opt/baccarat/current`
- 服務使用者：`baccarat`
- 網域：`example.com`
- 反向代理：`nginx`
- 常駐進程：`systemd`
- 資料庫：本機 PostgreSQL

## 1. 安裝系統套件

```bash
sudo apt update
sudo apt install -y nginx postgresql postgresql-contrib
```

安裝 `.nvmrc` 指定的 Node `22.19.0` 與 npm `10.9.3`；不要使用 distribution 未鎖版的 `nodejs`/`npm`。部署前必須確認：

```bash
node --version  # v22.19.0
npm --version   # 10.9.3
npm run verify:runtime
```

## 2. 建立系統使用者與目錄

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin baccarat
sudo mkdir -p /opt/baccarat
sudo mkdir -p /etc/baccarat
sudo chown -R baccarat:baccarat /opt/baccarat
sudo chown -R baccarat:baccarat /etc/baccarat
```

## 3. 建立 PostgreSQL 資料庫

```bash
sudo -u postgres createuser baccarat
sudo -u postgres psql -c "ALTER USER baccarat WITH PASSWORD 'replace-this-password';"
sudo -u postgres createdb -O baccarat baccarat
```

## 4. 放置專案與 build

把專案放到：

```bash
/opt/baccarat/current
```

然後執行：

```bash
cd /opt/baccarat/current
npm ci
npm run build
```

## 5. 設定 production env

複製範例檔：

```bash
sudo cp deploy/env/baccarat.env.example /etc/baccarat/baccarat.env
sudo chown baccarat:baccarat /etc/baccarat/baccarat.env
sudo chmod 600 /etc/baccarat/baccarat.env
```

至少要修改：

- `JWT_SECRET`
- `DATABASE_URL`

為每個環境產生不同且無法預測的 `JWT_SECRET`，不要自行編寫密碼或沿用範例值：

```bash
openssl rand -base64 48
```

將輸出填入 `/etc/baccarat/baccarat.env` 的 `JWT_SECRET`。production 啟動時會拒絕空值、
已知 placeholder、少於 32 bytes 或明顯低熵的值；請把 env 檔維持為 `0600`，不要提交實際 secret。

`BUSINESS_TIME_ZONE` 使用 IANA timezone，預設為 `Asia/Taipei`。玩家本日收益會以此 timezone 的 calendar day、依 round `settled_at` 認列，公式為 `total payout - total bet`；修改後必須重啟 API。

## 6. Database migration 與初始資料

```bash
sudo -u baccarat bash -lc '
  set -a
  source /etc/baccarat/baccarat.env
  set +a
  cd /opt/baccarat/current
  npm run db:migrate
  npm run db:migrate:status
  npm run db:bootstrap
'
```

注意：

- `api`、`worker`、bootstrap 與 seed 不會執行 DDL，schema 未升至目前版本時會直接停止
- migration 必須在啟動服務或執行 bootstrap/seed 前完成
- `npm run db:bootstrap` 建立服務所需桌別與牌靴；此操作可安全重跑，首次部署必須執行
- `npm run db:seed` 只應在你確定需要建立開發/測試用 demo 帳號時執行
- 如確定需要 demo 資料，請在上述 shell 中於 migration 後手動執行 `npm run db:seed`
- 正式環境的 `api` 與 `worker` 不會自動建立 demo player；player app 不提供 admin 登入或管理介面
- migration 操作與故障處理請見 [database-migrations.md](database-migrations.md)

## 7. 安裝 systemd services

```bash
sudo cp deploy/systemd/baccarat-api.service /etc/systemd/system/
sudo cp deploy/systemd/baccarat-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable baccarat-api baccarat-worker
sudo systemctl start baccarat-api baccarat-worker
```

檢查：

```bash
sudo systemctl status baccarat-api
sudo systemctl status baccarat-worker
journalctl -u baccarat-api -f
journalctl -u baccarat-worker -f
```

健康檢查分為：

- `GET /api/health/live`：只確認 API process 可回應。
- `GET /api/health/ready`（以及相容路徑 `/api/health`）：在 1.5 秒內檢查 PostgreSQL，並要求 round worker 最近 10 秒內有成功 tick；未就緒回傳 `503` 與各 dependency 狀態。

部署完成後應等待 readiness 回傳 `200`，不要只使用 liveness 判定可接流量。

## 8. 安裝 nginx 設定

```bash
sudo cp deploy/nginx/baccarat.conf /etc/nginx/sites-available/baccarat.conf
sudo ln -s /etc/nginx/sites-available/baccarat.conf /etc/nginx/sites-enabled/baccarat.conf
sudo nginx -t
sudo systemctl reload nginx
```

正式上線前，請先把：

- `server_name example.com;`
- `root /opt/baccarat/current/apps/web/dist;`

改成你的實際值。

## 9. SSL

建議用 Certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.com
```

## 10. 更新流程

每次更新：

```bash
cd /opt/baccarat/current
sudo systemctl stop baccarat-api baccarat-worker
pg_dump -U baccarat -Fc baccarat > /var/backups/baccarat-before-deploy-$(date +%F-%H%M%S).dump
git pull
npm ci
npm run build
sudo -u baccarat bash -lc '
  set -a
  source /etc/baccarat/baccarat.env
  set +a
  cd /opt/baccarat/current
  npm run db:migrate
  npm run db:migrate:status
  npm run db:bootstrap
'
sudo systemctl start baccarat-api baccarat-worker
sudo systemctl reload nginx
```

若 migration 或狀態檢查失敗，不要啟動服務；依 [database-migrations.md](database-migrations.md) 處理後再繼續。

## 11. 備份

至少做每日 `pg_dump`：

```bash
pg_dump -U baccarat baccarat > /var/backups/baccarat-$(date +%F).sql
```

## 12. 財務帳本檢核

所有玩家餘額異動都會寫入 append-only `financial_ledger_entries`，並保留對應的 actor、source 與 reference。部署後可執行：

```sql
SELECT *
FROM financial_balance_reconciliation
WHERE NOT is_reconciled;
```

正常結果應為零筆。Server 端亦提供 `reconcileUserBalance(userId)` 與 `reconcileAllUserBalances()` 供營運檢核。`game_rounds`、`bets` 與 ledger 不再由 daily cleanup 刪除；未來若導入 archive，必須保留 reference 可追溯性與 reconciliation 能力。

## 13. 重要說明

- 前端是同網域部署，預設走 `/api`
- Database integrity constraints 的 production preflight、驗證與 rollback 步驟見 [`database-integrity.md`](./database-integrity.md)。
- WebSocket 透過 `/api/ws` 經 nginx 轉發到後端
- API 和 worker 是兩個獨立服務，都必須常駐
- 不要同時啟多個 worker，否則會重複推局

### Session security

- Access JWT 僅存於 browser memory，效期 15 分鐘；不得改回 `localStorage`。
- 7 天 refresh token 只以 `HttpOnly`、`SameSite=Strict` cookie 傳輸，資料庫只保存 SHA-256 hash；每次 refresh 都 rotation。
- `POST /api/auth/logout` 會 revoke server session、清 cookie，並關閉同一 session 的 WebSocket；後續 HTTP request 即使尚有未過期 access JWT 也會被拒絕。
- nginx security headers 包含 CSP、HSTS、frame/MIME/referrer/permissions/COOP。HSTS 只有在 HTTPS 回應生效，上線前必須先完成 TLS 與 HTTP→HTTPS redirect。

- DB pool 預設每個 process 最多 20 connections、3 秒 connect timeout、5 秒 statement/query timeout；調高 `DATABASE_POOL_MAX` 前必須把 API＋worker instance 數一起納入 PostgreSQL `max_connections` 容量計算。
