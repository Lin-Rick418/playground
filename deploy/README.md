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

為每個環境產生不同且無法預測的 `JWT_SECRET`，不要自行編寫密碼或沿用範例值：

```bash
openssl rand -base64 48
```

將輸出填入 `/etc/baccarat/baccarat.env` 的 `JWT_SECRET`。production 啟動時會拒絕空值、
已知 placeholder、少於 32 bytes 或明顯低熵的值；請把 env 檔維持為 `0600`，不要提交實際 secret。

## 6. 初始資料

```bash
cd /opt/baccarat/current
sudo -u baccarat env $(cat /etc/baccarat/baccarat.env | xargs) npm run db:seed
```

注意：

- `npm run db:seed` 只應在你確定需要建立開發/測試用 demo 帳號時執行
- 正式環境的 `api` 與 `worker` 啟動時只會初始化資料表、桌別與牌靴，不會自動建立 `admin/admin123` 或 `player1/player123`

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
