# Single-Server Deployment

這份配置採 immutable release 與 least-privilege service account：部署者只能在 staging build，只有 root 能 promote release 與切換 `current`；API 與 worker 無法修改 code、env 或彼此的 runtime directory。

## 支援基線

- Ubuntu 22.04+ / Debian 11+
- systemd 247+
- Node.js 22 LTS（固定安裝於 `/usr/bin/node`）
- nginx
- PostgreSQL（本機或可經 DNS 解析的遠端位址）
- release root：`/opt/baccarat/releases`
- active symlink：`/opt/baccarat/current`

## 1. 安裝系統套件

```bash
sudo apt update
sudo apt install -y nginx postgresql postgresql-contrib nodejs npm
node --version
systemd-analyze --version
```

正式環境應透過發行商 repository 或 NodeSource 固定 Node 22 的 major/minor 版本；升級 Node 後要重新執行本文件的 sandbox 驗證。

## 2. 建立身份與 ownership boundary

`deployer` 是部署人員 group；`baccarat` 只用來讓兩個 runtime account 讀取 production env。兩個 runtime account 必須是不同 UID、無 home、無 login shell，且不得加入 `deployer` group。

```bash
sudo groupadd --force deployer
sudo groupadd --system --force baccarat
sudo useradd --system --gid baccarat --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin baccarat-api
sudo useradd --system --gid baccarat --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin baccarat-worker
sudo usermod -aG deployer <deploy-user>
```

重新登入 deploy user 讓 group 生效，再建立目錄：

```bash
sudo install -d -o root -g deployer -m 0755 /opt/baccarat
sudo install -d -o root -g deployer -m 2770 /opt/baccarat/staging
sudo install -d -o root -g deployer -m 0755 /opt/baccarat/releases
sudo install -d -o root -g baccarat -m 0750 /etc/baccarat
```

不要把 `/opt/baccarat` 或 `/etc/baccarat` `chown` 給 runtime account。`/run/baccarat-api` 與 `/run/baccarat-worker` 由 systemd 在每次啟動時建立，無須手動配置。

## 3. 建立 PostgreSQL database

```bash
sudo -u postgres createuser baccarat
sudo -u postgres createdb -O baccarat baccarat
sudo -u postgres psql
\password baccarat
\q
```

API 和 worker 都需要 PostgreSQL；systemd sandbox 因此保留 `AF_UNIX`、`AF_INET`、`AF_INET6` 與 DNS 所需的正常 socket/syscall。

## 4. 建立 immutable release

部署者只在新的 timestamped staging directory 中安裝與 build。確認 build 後，由 root 將完成的 tree freeze 為 `root:deployer`、移除 group/other write bit，再 promote 到 root-only release directory：

```bash
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING_DIR="/opt/baccarat/staging/$RELEASE_ID"
RELEASE_DIR="/opt/baccarat/releases/$RELEASE_ID"

git clone --depth 1 <repository-url> "$STAGING_DIR"
cd "$STAGING_DIR"
npm ci
npm run build
npm run test:deploy
npm prune --omit=dev

sudo chown -R root:deployer "$STAGING_DIR"
sudo chmod -R u=rwX,go=rX "$STAGING_DIR"
sudo mv "$STAGING_DIR" "$RELEASE_DIR"
```

不要讓 `deployer` 對 `/opt/baccarat/releases` 有 write permission，也不要在 `/opt/baccarat/current` 執行 `git pull`、`npm install` 或 build。每次更新都從 staging promote 新 release；這同時保留不可被 deployment group 原地改寫的 rollback target。

第一次或切版時，以 root 原子替換 symlink：

```bash
sudo ln -s "$RELEASE_DIR" "/opt/baccarat/.current-$RELEASE_ID"
sudo chown -h root:deployer "/opt/baccarat/.current-$RELEASE_ID"
sudo mv -Tf "/opt/baccarat/.current-$RELEASE_ID" /opt/baccarat/current
```

## 5. 設定唯讀 production env

```bash
sudo install -o root -g baccarat -m 0640 \
  /opt/baccarat/current/deploy/env/baccarat.env.example \
  /etc/baccarat/baccarat.env
sudoedit /etc/baccarat/baccarat.env
```

至少修改 `JWT_SECRET` 與 `DATABASE_URL`。env 必須維持 `root:baccarat`、mode `0640`（或修改完成後改成 `0440`）；runtime account 可以讀取但不可修改。正式環境不要執行建立 demo 帳號的 `npm run db:seed`。

## 6. 安裝與驗證 systemd units

```bash
sudo install -o root -g root -m 0644 \
  /opt/baccarat/current/deploy/systemd/baccarat-api.service \
  /etc/systemd/system/baccarat-api.service
sudo install -o root -g root -m 0644 \
  /opt/baccarat/current/deploy/systemd/baccarat-worker.service \
  /etc/systemd/system/baccarat-worker.service

sudo systemd-analyze verify \
  /etc/systemd/system/baccarat-api.service \
  /etc/systemd/system/baccarat-worker.service
sudo /opt/baccarat/current/deploy/scripts/validate-install-permissions.sh

sudo systemctl daemon-reload
sudo systemctl enable --now baccarat-api baccarat-worker
```

`validate-install-permissions.sh` 必須以 root 執行；它會確認 current 指向 release root、active release 不可由 runtime user 修改、env ownership/mode、unit ownership，以及 API/worker 的實際 write permission。

## 7. 安裝 nginx

```bash
sudo install -o root -g root -m 0644 \
  /opt/baccarat/current/deploy/nginx/baccarat.conf \
  /etc/nginx/sites-available/baccarat.conf
sudo ln -s /etc/nginx/sites-available/baccarat.conf /etc/nginx/sites-enabled/baccarat.conf
sudo nginx -t
sudo systemctl reload nginx
```

正式上線前修改 `server_name example.com`。`root /opt/baccarat/current/apps/web/dist` 可以保留，nginx 對 immutable web build 僅有 read access。

## 8. TLS

正式環境必須在啟用外部流量前配置 TLS。可使用 Certbot 驗證 nginx 設定並取得憑證：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.com
```

## 9. 上線檢查

```bash
sudo systemctl status baccarat-api baccarat-worker
curl --fail http://127.0.0.1:4000/health
sudo systemd-analyze security --no-pager baccarat-api.service
sudo systemd-analyze security --no-pager baccarat-worker.service
sudo /opt/baccarat/current/deploy/scripts/validate-install-permissions.sh
journalctl -u baccarat-api -u baccarat-worker --since '10 minutes ago'
```

repository 內的 `npm run test:deploy` 會執行 portable static assertions；Linux 有 `systemd-analyze` 時，還會執行 `verify` 與 offline `security`，並拒絕 exposure score 高於 `4.5` 的 unit。

## 10. Sandbox 邊界與相容性決策

- API 與 worker 使用不同 UID 與 mode `0700` 的 `/run` directory。兩者只有自己的 `/run/baccarat-*` 與 private `/tmp` 可寫；application state、log 與 game state 分別交給 PostgreSQL 與 journald。
- `ProtectSystem=strict`、`ProtectHome=true` 與明確 `ReadOnlyPaths` 讓 code/env 在 service mount namespace 中唯讀；`ReadWritePaths` 沒有包含 `/opt` 或 `/etc`。
- capability set 為空，並開啟 `NoNewPrivileges`、`PrivateDevices`、kernel/control-group protection、namespace restriction、`UMask=0077` 與 core dump disable。
- `SystemCallFilter=@system-service` 是 Node/libuv 相容的 allow-list；不使用容易誤擋 PostgreSQL/DNS 的任意 syscall blacklist。
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` 支援 local socket、IPv4/IPv6、DNS 與 remote PostgreSQL。沒有啟用 `PrivateNetwork` 或全域 `IPAddressDeny`。
- `MemoryDenyWriteExecute=false` 是刻意的 Node/V8 相容例外。V8 JIT 需要 executable memory；只有完成 `node --jitless` 的效能與功能驗證後，才能把它改為 `true`。
- `TasksMax`、`LimitNOFILE` 與 `LimitCORE` 提供保守 resource boundary。記憶體與 CPU limit 應根據 production telemetry 另加 drop-in，不能用未量測的固定值造成 OOM/restart loop。

systemd 的 hardening directive 或 Node major version 變更後，必須先在 staging 做 API、WebSocket、DNS、PostgreSQL、worker round transition 與 graceful restart smoke test。

## 11. 更新與 rollback

更新時重複「建立 immutable release」，再安裝該 release 的 units、執行 validator、切換 `current` 並 restart。不要原地覆寫 current release。

完整 rollback 步驟與 database 注意事項見 [ROLLBACK.md](./ROLLBACK.md)。

## 12. 備份

至少每日備份 PostgreSQL，且備份檔不可由 service account 寫入：

```bash
sudo install -d -o postgres -g postgres -m 0700 /var/backups/baccarat
sudo -u postgres sh -c \
  'umask 077; pg_dump baccarat > "/var/backups/baccarat/baccarat-$(date +%F).sql"'
```

## 13. 重要說明

- 前端與 API 同網域，預設走 `/api`；WebSocket 由 `/api/ws` 轉發。
- API 與 worker 都必須常駐，但 worker 不依賴 API process 才能啟動。
- 只能執行一個 worker instance，否則會重複推局。
