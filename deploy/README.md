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

`release.config.json` 是 release branch 的 authoritative 設定；目前正式 release branch 為
`master`、remote 為 `origin`。若正式流程改用其他 branch，必須透過受 review 的 commit
更新該檔，不要在部署主機臨時略過 branch 檢查。

每次更新先讓本機 branch 以 fast-forward 對齊 remote：

```bash
cd /opt/baccarat/current
release_branch=$(node -p "require('./release.config.json').authoritativeBranch")
release_remote=$(node -p "require('./release.config.json').remote")
git fetch --prune "$release_remote"
git switch "$release_branch"
git merge --ff-only "$release_remote/$release_branch"
npm ci
npm test --workspace server
npm run test:release
npm run release:build
```

`release:build` 會再次 fetch，並在任何下列狀況拒絕 release：

- tracked 或 untracked 檔案造成 dirty worktree
- 不在 `release.config.json` 指定的 authoritative branch
- upstream 不符指定的 remote/branch 或尚未設定
- local branch 尚未 push、落後 remote，或已 diverge

Build 完成後，server 與 web artifact 都會寫入同一份 exact commit SHA。重啟前應先保留
preflight/build log，並核對兩個 artifact：

```bash
cat apps/server/dist/build-metadata.json
cat apps/web/dist/build-metadata.json
```

確認兩者的 `commitSha`、`branch`、`builtAt` 完全一致且 `dirty` 為 `false` 後再部署：

```bash
sudo systemctl restart baccarat-api baccarat-worker
sudo systemctl reload nginx
```

部署後可從後端與前端分別查核實際 artifact，兩個 response 必須仍是同一 SHA：

```bash
curl --fail https://example.com/api/build-metadata
curl --fail https://example.com/build-metadata.json
```

Release 紀錄至少應保存部署時間、操作者、preflight output 與上述 exact `commitSha`；rollback
也必須指向已知 SHA 並重新走同一套 preflight/build/verify 流程，不得直接部署來源不明的工作目錄。

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
