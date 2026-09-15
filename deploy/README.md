# Production deployment

本目錄提供 production env、nginx、systemd、atomic deployment、rollback 與 PostgreSQL backup 工具。正式服務只有 player app；本 repository 不提供 admin 頁面或 admin API。

部署安全邊界如下：deployer 只能在 root 建立的 staging 內 build；只有 root 可以 promote release、修改 `current`／`previous` symlink；API、worker、backup 使用不同 UID，不能修改 code、env 或其他 service 的 runtime data。

## 1. Host、runtime 與身份

以下範例以 Ubuntu 24.04、PostgreSQL 16、nginx 為基礎：

```bash
sudo apt update
sudo apt install -y nginx postgresql postgresql-contrib curl certbot jq
```

安裝 `.nvmrc` 指定的 Node `22.19.0` 與 npm `10.9.3`，固定於 `/usr/bin/node` 可取得的位置，然後確認：

```bash
node --version
npm --version
npm run verify:runtime
systemd-analyze --version
```

建立 deploy group、共用唯讀 config group 與三個獨立 runtime account。runtime account 不得加入 `deployer`：

```bash
sudo groupadd --force deployer
sudo groupadd --system --force baccarat
for service in api worker backup; do
  sudo useradd --system --gid baccarat --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin "baccarat-$service"
done
sudo usermod -aG deployer <deploy-user>

sudo install -d -o root -g deployer -m 0755 /opt/baccarat /opt/baccarat/releases
sudo install -d -o root -g baccarat -m 0750 /etc/baccarat
sudo install -d -o baccarat-backup -g baccarat -m 0700 /var/backups/baccarat
```

建立 PostgreSQL role/database 後安裝 env：

```bash
sudo install -o root -g baccarat -m 0640 \
  deploy/env/baccarat.env.example /etc/baccarat/baccarat.env
sudoedit /etc/baccarat/baccarat.env
```

必須替換 `JWT_SECRET` 與 `DATABASE_URL`。建議用 `openssl rand -base64 48` 產生每個環境獨立的 JWT secret。`BUSINESS_TIME_ZONE` 必須是 IANA timezone，預設 `Asia/Taipei`。env 必須是 regular file，不得使用 symlink、不得可由 group 寫入或由 other 讀取。

systemd 直接使用 `EnvironmentFile`。一次性維運指令使用安全 loader，不要以 `env $(cat ...)`、`xargs` 或 command substitution 展開 secret：

```text
node deploy/bin/run-with-env-file.mjs <env-file> -- <command> [args...]
```

Loader 先以 `O_NOFOLLOW` 檢查 file type、owner/group 與 mode，再直接建立 child environment；值中的空白、`$`、backtick、`#`、`=` 不會經 shell 解譯，也不會出現在 argv 或錯誤訊息。production deploy、migration 與 backup scripts 同樣只透過 process environment 傳遞 database URL。

## 2. 安裝與驗證 services／nginx

```bash
sudo install -o root -g root -m 0644 deploy/systemd/baccarat-api.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/baccarat-worker.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/baccarat-backup.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/baccarat-backup.timer /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/baccarat-maintenance.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/baccarat-maintenance.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/baccarat-*.service
sudo systemctl daemon-reload
sudo systemctl enable baccarat-api baccarat-worker baccarat-backup.timer baccarat-maintenance.timer
```

nginx 是本部署模式唯一支援的 TLS edge。先確認正式網域 DNS 已指向主機，
再用不依賴既有憑證的 bootstrap config 取得第一張憑證：

```bash
sudo install -d -o root -g www-data -m 0750 /var/www/certbot
sudo install -o root -g root -m 0644 \
  deploy/nginx/baccarat-acme-bootstrap.conf /etc/nginx/sites-available/baccarat.conf
sudo sed -i 's/example.com/your-domain.example/g' /etc/nginx/sites-available/baccarat.conf
sudo ln -sfn /etc/nginx/sites-available/baccarat.conf /etc/nginx/sites-enabled/baccarat.conf
sudo nginx -t
sudo systemctl reload nginx

sudo certbot certonly --webroot --webroot-path /var/www/certbot \
  --domain your-domain.example --agree-tos --email ops@your-domain.example
```

取得憑證後，把正式 TLS config 的 `server_name`、`ssl_certificate` 與
`ssl_certificate_key` 全部替換成實際網域／路徑，再啟用：

```bash
sudo install -o root -g root -m 0644 deploy/nginx/baccarat.conf /etc/nginx/sites-available/baccarat.conf
sudo sed -i 's/example.com/your-domain.example/g' /etc/nginx/sites-available/baccarat.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
systemctl list-timers certbot.timer
```

最後驗證 HTTP 只做 redirect、HTTPS 才有 HSTS，並確認 refresh cookie 與
WebSocket 都使用安全連線：

```bash
curl -I http://your-domain.example/
curl -I https://your-domain.example/
```

預設 HSTS 只有 `max-age`。只有確認該網域的所有現在與未來子網域都永久
支援 HTTPS 後，才能加入 `includeSubDomains`；完成 preload requirements 與
撤回風險評估前不得加入 `preload`。

純 HTTP 的 production 部署不受支援：production refresh cookie 固定為
`Secure`，瀏覽器不會透過 HTTP 回送。無法使用公有 CA 的內網環境應使用
受所有 client 信任的內部 CA，仍須保留 HTTPS。

CDN／load balancer 置於本 nginx 前方目前也不受支援。若未來新增外部 edge，
必須另外設計 nginx `real_ip` trust boundary、Express `trust proxy`、由 edge
發送 HSTS，並重新驗證 login/WS 的 per-IP rate limiting。

只允許一個 worker instance，避免重複推局。

預設 web、API 與 WebSocket 都由同一個 nginx origin 提供，因此 CSP 的
`connect-src 'self'` 已涵蓋 `/api` 與同源 `wss://`。不要加入裸的 `ws:` 或
`wss:`，那會允許連線到任意主機。若另行設定 `VITE_API_BASE_URL` 指向不同
origin，必須在 CSP 加入該完整且固定的 `https://`／`wss://` origin，並同步
設定 server 的 `CORS_ORIGIN`；部署後需確認 browser console 沒有 CSP violation。

## 3. Release 前置檢查

`release.config.json` 的 authoritative branch 是 `main`、remote 是 `origin`。release source 必須是乾淨 worktree、正確 upstream，且 local SHA 與 remote 完全一致：

```bash
git fetch --prune origin
git switch main
git merge --ff-only origin/main
npm ci
npm run check:static
npm test
npm run test:release
npm run test:ops
npm run test:deploy
npm run release:preflight
```

`npm run build` 會在 server 與 web artifact 寫入同一份 exact `commitSha`、branch、dirty flag 與 build time。release 必須確認兩份 metadata 的 SHA 相同且 `dirty` 為 `false`。

## 4. Atomic deployment

用 deploy user 的乾淨 checkout 執行，第一次永遠先 dry-run。`sudo` 時腳本以 `SUDO_USER` 執行 build/hook，之後由 root freeze 與 promote；也可明確傳入 `--build-user`：

```bash
sha="$(git rev-parse HEAD)"
sudo deploy/scripts/deploy.sh --source "$(pwd)" --sha "$sha" --dry-run
sudo deploy/scripts/deploy.sh --source "$(pwd)" --sha "$sha" --apply
```

流程依序：驗證 source/SHA/env/lock、建立 staging、執行 `npm ci` 與 build、檢查 migration rollback compatibility、執行 migration、把完整 tree freeze 成 root-owned immutable release、原子切換 `current`、restart API/worker 並檢查 readiness。失敗時會切回已驗證相容的 previous release；deploy command 仍回傳 non-zero。

Release 存在且 marker 完整時不會重跑 build/migration。相同 SHA 已 active 時只做 readiness。腳本不會自動刪除 `.staging`，因 migration 狀態可能未知；先檢查 log 與 `.migration-started` 再人工處理。部署鎖位於 `/opt/baccarat/.deploy.lock`，只有確認沒有 deploy/rollback process 時才可移除 stale lock。

### Migration contract

API、worker、bootstrap 與 seed 不執行 DDL；schema version 或 live fingerprint 不符時直接停止。部署腳本 feature-detect `db:migrate`，並在 activation 前執行 migration。

Migration 必須採 expand/contract。若 active release 可能無法搭配新 schema，`deploy/hooks/verify-rollback-compatibility PREVIOUS_RELEASE` 必須回 non-zero，並改用 coordinated maintenance deployment。詳細操作見 [database-migrations.md](database-migrations.md)。

Optional executable hooks 位於 `deploy/hooks/`：

| Hook | 契約 |
| --- | --- |
| `preflight` | `npm ci` 前檢查 release-specific 外部依賴。 |
| `build` | 取代預設 build，仍須產生 server/web artifacts 與 metadata。 |
| `migrate` | activation 前執行，必須可觀察且可安全 retry。 |
| `verify-rollback-compatibility PREVIOUS_RELEASE` | migration 前證明 previous code 相容。 |
| `readiness HEALTH_URL` | 取代預設 readiness request。 |

首次部署在 migration 後執行 `npm run db:bootstrap` 建立必要桌別與牌靴。Production 禁止執行 `npm run db:seed`；它只供隔離的 development／test 環境建立 demo player。需要 seed 時，使用由執行者持有、mode `0600` 的非 production env file：

```bash
node deploy/bin/run-with-env-file.mjs /path/to/development.env -- npm run db:seed
```

## 5. 驗證、sandbox 與 rollback

```bash
readlink -f /opt/baccarat/current
curl --fail http://127.0.0.1:4000/health
sudo systemctl status baccarat-api baccarat-worker
sudo systemd-analyze security --no-pager baccarat-api.service
sudo systemd-analyze security --no-pager baccarat-worker.service
sudo /opt/baccarat/current/deploy/scripts/validate-install-permissions.sh
sudo journalctl -u baccarat-api -u baccarat-worker --since '-10 minutes'
curl --fail https://example.com/api/build-metadata
curl --fail https://example.com/build-metadata.json
```

`/health/live` 只確認 process；`/health/ready` 與相容路徑 `/health` 會檢查 PostgreSQL 與 worker heartbeat。nginx 對外路徑加上 `/api`。

API／worker 只有自己的 `/run/baccarat-*` 與 private `/tmp` 可寫。`ProtectSystem=strict`、空 capability set、namespace/kernel protection 與 syscall allow-list 阻止修改 release/env。`MemoryDenyWriteExecute=false` 是 Node/V8 JIT 的相容例外；除非先完成 `node --jitless` 功能與效能驗證，不得改為 `true`。

Rollback 預設也是 dry-run：

```bash
sudo deploy/scripts/rollback.sh --dry-run
sudo deploy/scripts/rollback.sh --apply
sudo deploy/scripts/rollback.sh --target-sha <sha> --dry-run
```

執行過 migration 的 release 只能 rollback 到 marker 中已驗證相容的 SHA。rollback readiness 失敗時會恢復原 active symlink 並 restart。完整事故流程見 [ROLLBACK.md](ROLLBACK.md)。

## 6. Backup、restore 與 retention

```bash
sudo -u baccarat-backup /opt/baccarat/current/deploy/scripts/backup.sh create \
  --env-file /etc/baccarat/baccarat.env --backup-dir /var/backups/baccarat

sudo -u baccarat-backup /opt/baccarat/current/deploy/scripts/backup.sh verify \
  /var/backups/baccarat/<backup>.dump

sudo -u baccarat-backup /opt/baccarat/current/deploy/scripts/backup.sh prune \
  --backup-dir /var/backups/baccarat --keep 14
```

Backup 是 PostgreSQL custom-format `.dump` 與相鄰 `.sha256`，以 temporary file + rename 發佈，權限 `0600`。prune 預設只列出，review 後才加 `--apply`；daily systemd timer 會明確使用 `--keep 14 --apply`。

過期 idempotency/session metadata 由獨立 hourly timer 分批清除，不和 API 或 round worker 綁在同一個 process：

```bash
systemctl status baccarat-maintenance.timer
sudo systemctl start baccarat-maintenance.service
journalctl -u baccarat-maintenance.service -o cat --since '-1 day' | jq .
```

保留期限、永久保存資料與停用 cleanup 的 rollback 作法見 [data-retention.md](../docs/data-retention.md)。

至少每月 restore 到全新空白 scratch database。restore env 必須設定 `ALLOW_RESTORE_VERIFICATION=true`、`RESTORE_VERIFY_DATABASE_URL` 與完全相符的 `RESTORE_VERIFY_EXPECTED_DATABASE`。不要將 production URL 放入 restore verification env，也不要對 production 執行 `pg_restore --clean`。

## 7. 財務與安全檢核

所有玩家餘額異動都寫入 append-only `financial_ledger_entries`；database trigger 會拒絕未 journal 的直接 balance update。部署後確認下列查詢為零筆：

```sql
SELECT * FROM financial_balance_reconciliation WHERE NOT is_reconciled;
```

Access JWT 只存 browser memory；refresh token 使用 `HttpOnly`、`SameSite=Strict` cookie，資料庫只保存 hash 並於每次 refresh rotation。logout 或改密碼會 revoke server session。DB pool、API 與 worker instance 數必須一併納入 PostgreSQL `max_connections` 規劃。

## Casino PWA

### 發布與檢查

沿用既有 build／原子切換 release 流程，發布完整 `apps/web/dist`，包括 `/sw.js`、`/manifest.webmanifest`、`/pwa/` 與 `/icons/`。使用本 repository 的 Nginx 設定後執行 `nginx -t`，再依原部署流程 reload。Service Worker、Manifest、離線頁與圖示使用 `expires -1`（`Cache-Control: no-cache`），保留上層 CSP／HSTS；缺失資源必須回傳 404。

```bash
curl -I https://your-domain.example/sw.js
curl -I https://your-domain.example/manifest.webmanifest
curl -I https://your-domain.example/pwa/offline.html
curl -I https://your-domain.example/pwa/missing.html
```

前三項應為 200、正確 MIME type 與 `Cache-Control: no-cache`；最後一項應為 404。正式 HTTPS 憑證需受裝置信任。Manifest 名稱／短名稱皆為 Casino，從 `/login` 啟動，既有登入狀態仍交由 router 與伺服器驗證。

### 快取與更新

Service Worker 只保存 `/pwa/offline.html`、`/pwa/offline.css`、`/pwa/offline.js`，存於私有 `casino-pwa-offline` cache。API、帳戶／下注資料、正常 SPA HTML、遊戲圖像與語音不加入 PWA 快取。離線 fallback 只處理同源頁面導覽的網路失敗，保留 HTTP 錯誤；已開啟頁面的離線提示不代表能偵測所有伺服器故障。

不使用 `skipWaiting`、`clientsClaim` 或自動 reload。首次安裝後，下一次頁面導覽才會由 Service Worker 控制。新版等待所有受控分頁與 App 視窗關閉後啟用，啟用時移除本 cache 的舊 revision，不清理其他應用程式 cache。正常網頁始終依一般網路載入，這個等待政策針對 Service Worker，並不鎖定 SPA 版本。

### 回復版本

回復至另一個包含 PWA 的 release 時，一併回復完整 dist；瀏覽器取得回復版 Service Worker 後，仍遵循關閉全部受控頁面再啟用的政策。若回復到加入 PWA 以前的 release，不能只讓 `/sw.js` 變成 404：應先發布同路徑的退役 worker，啟用後只刪除 `casino-pwa-offline` 並自行 unregister，且仍不強制 reload。必要時可在受影響裝置的 DevTools 手動 unregister 與移除該 cache；這不是一般發布步驟。

### 驗收

執行 `npm run test:pwa`，以隔離的 production builds 和 Vite preview 驗證安裝設定、離線導覽、恢復連線、HTTP 錯誤與版本等待，不使用真實帳戶或資料庫。再於 Android Chrome／iPhone Safari 實機確認安裝、圖示、standalone 啟動、離線提示與關閉後更新。自動化的手機尺寸測試涵蓋登入頁高度與無教學介面，不取代 iOS 實機安裝驗收。

圖示以 `apps/web/public/icons/casino.svg` 為來源，採綠底金色 C 字標；PNG 包含 192、512、512 maskable 與 180 Apple Touch Icon，中央字標位於 maskable 安全區。
