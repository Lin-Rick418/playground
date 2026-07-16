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
sudo apt install -y nginx postgresql postgresql-contrib nodejs npm
```

如果你要固定 Node 版本，建議改用 NodeSource 或 `nvm` 安裝 Node 20+。

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
npm install
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

`baccarat.env` 必須是由執行服務的 `baccarat` 使用者擁有、mode 為 `0600`（唯讀部署也可用 `0400`）的 regular file。不要使用 symlink，也不要透過 command substitution 將 env file 展開成 command arguments，或把 secret 直接寫在 command line；這些方式會造成 shell word splitting，並可能讓 secret 出現在 `ps`、`/proc/*/cmdline` 或操作紀錄。

systemd services 直接使用 `EnvironmentFile=/etc/baccarat/baccarat.env`。需要執行一次性維運指令時，使用專案提供的安全 loader；它不經 shell 展開，並會先檢查檔案型態、owner 與 mode：

```text
node deploy/bin/run-with-env-file.mjs <env-file> -- <command> [args...]
```

env file 使用每行 `KEY=value` 的格式。含空白或需要保留前後空白時可使用單引號或雙引號；`$`、backtick、`#`、`=` 等字元只會作為值傳給 child process，不會被當成 shell 指令執行。loader 的錯誤訊息不會印出變數值。

## 6. 初始資料

注意：

- production 不可執行 `npm run db:seed`；它會建立使用公開預設密碼的 demo 帳號
- 正式環境的 `api` 與 `worker` 啟動時只會初始化資料表、桌別與牌靴，不會自動建立 `admin/admin123` 或 `player1/player123`
- 只有在明確隔離的 development/staging 環境需要 demo 資料時，才可使用下列安全 wrapper；完成測試後應移除 demo 帳號

```bash
sudo -u baccarat node /opt/baccarat/current/deploy/bin/run-with-env-file.mjs \
  /etc/baccarat/baccarat.env -- \
  npm --prefix /opt/baccarat/current run db:seed
```

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
git pull
npm install
npm run build
sudo systemctl restart baccarat-api baccarat-worker
sudo systemctl reload nginx
```

## 11. 備份

至少做每日 `pg_dump`：

```bash
pg_dump -U baccarat baccarat > /var/backups/baccarat-$(date +%F).sql
```

## 12. 重要說明

- 前端是同網域部署，預設走 `/api`
- WebSocket 透過 `/api/ws` 經 nginx 轉發到後端
- API 和 worker 是兩個獨立服務，都必須常駐
- 不要同時啟多個 worker，否則會重複推局
