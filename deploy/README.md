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

## 6. 初始資料

先用 password manager 產生至少 16 字元的唯一 Admin 密碼，並把一次性 credentials 放在僅服務帳號可讀的暫存檔：

```bash
cd /opt/baccarat/current
sudo install -o baccarat -g baccarat -m 600 /dev/null /etc/baccarat/bootstrap.env
sudoedit /etc/baccarat/bootstrap.env
sudo -u baccarat sh -c 'set -a; . /etc/baccarat/baccarat.env; set +a; BOOTSTRAP_ADMIN_CREDENTIALS_FILE=/etc/baccarat/bootstrap.env exec npm run admin:bootstrap'
sudo rm -f /etc/baccarat/bootstrap.env
```

`/etc/baccarat/bootstrap.env` 的內容格式：

```dotenv
BOOTSTRAP_ADMIN_USERNAME=your_admin_username
BOOTSTRAP_ADMIN_PASSWORD=a-unique-password-of-16-to-72-characters
```

注意：

- `admin:bootstrap` 只允許在資料庫尚無任何 Admin 時執行；重跑會失敗，不會覆寫或重設既有帳號
- 所有環境的 `api` 與 `worker` 都不會自動建立 Admin 或 Player
- bootstrap credential file 必須是 `0600`（或更嚴格），只供這次命令使用；成功後應立即刪除，不能加入 production env、systemd 或 repository

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
