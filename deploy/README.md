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
- 正式環境的 `api` 與 `worker` 不會自動建立 `admin/admin123` 或 `player1/player123`
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
npm install
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

## 12. 重要說明

- 前端是同網域部署，預設走 `/api`
- WebSocket 透過 `/api/ws` 經 nginx 轉發到後端
- API 和 worker 是兩個獨立服務，都必須常駐
- 不要同時啟多個 worker，否則會重複推局
