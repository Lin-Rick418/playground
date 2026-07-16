# Single-server operator runbook

本 runbook 適用 Ubuntu / Debian 單機部署：nginx 提供 web、systemd 管理 API 與 worker、PostgreSQL 保存資料。正式部署不再直接修改 `/opt/baccarat/current`；每個 Git SHA 都是獨立且唯讀的 release：

```text
/opt/baccarat/
├── current  -> /opt/baccarat/releases/<active-sha>
├── previous -> /opt/baccarat/releases/<previous-sha>
└── releases/
    ├── <sha-a>/
    └── <sha-b>/
```

`current` 透過 filesystem rename 原子切換。nginx、`baccarat-api.service` 與 `baccarat-worker.service` 都只參照 `current`，因此不需要在 unit file 寫死 release SHA。

## 1. Host bootstrap

```bash
sudo apt update
sudo apt install -y nginx postgresql postgresql-contrib nodejs npm curl
sudo useradd --system --create-home --shell /usr/sbin/nologin baccarat
sudo install -d -o root -g baccarat -m 0755 /opt/baccarat
sudo install -d -o root -g baccarat -m 0775 /opt/baccarat/releases
sudo install -d -o baccarat -g baccarat -m 0700 /etc/baccarat /var/backups/baccarat
```

建議固定專案支援的 Node major version，且在 staging 先驗證 lockfile。部署腳本會以 `baccarat` 執行 `npm ci`、build 與 migration hook，避免 npm lifecycle 以 root 身分執行。

建立 PostgreSQL role/database 後，安裝 production env：

```bash
sudo install -o baccarat -g baccarat -m 0600 \
  deploy/env/baccarat.env.example /etc/baccarat/baccarat.env
sudoedit /etc/baccarat/baccarat.env
```

必須替換 `JWT_SECRET` 與 `DATABASE_URL`。env parser 不使用 `eval`、`xargs` 或 command substitution；database URL 只透過 process environment 傳給 libpq，不會出現在 `pg_dump`、`pg_restore` 或 `psql` argv。

## 2. Install services and nginx

```bash
sudo install -m 0644 deploy/systemd/baccarat-api.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/baccarat-worker.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/baccarat-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/baccarat-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable baccarat-api baccarat-worker baccarat-backup.timer

sudo install -m 0644 deploy/nginx/baccarat.conf /etc/nginx/sites-available/baccarat.conf
sudo ln -s /etc/nginx/sites-available/baccarat.conf /etc/nginx/sites-enabled/baccarat.conf
sudo nginx -t
sudo systemctl reload nginx
```

把 nginx `server_name` 改為正式網域，再用 Certbot 或既有 PKI 設定 TLS。不要啟動第二個 worker，否則可能重複推局。

## 3. Release procedure

在乾淨、已 review 的 checkout 執行。第一次永遠先 dry-run：

```bash
sha="$(git rev-parse HEAD)"
sudo deploy/scripts/deploy.sh \
  --source "$(pwd)" \
  --sha "$sha" \
  --dry-run
```

確認 SHA、source 與 release path 後才套用：

```bash
sudo deploy/scripts/deploy.sh \
  --source "$(pwd)" \
  --sha "$sha" \
  --apply
```

執行順序固定為：

1. 驗證 SHA、production env、必要工具、`current` 與 deployment lock。
2. 複製 source 到 `/opt/baccarat/releases/.<sha>.staging`，排除 `.git`、`node_modules` 與舊 `dist`。
3. 執行 optional preflight hook、`npm ci` 與完整 build。
4. Feature-detect migration，必要時先驗證 previous release 仍可配合新 schema。
5. 完成 migration 後將 staging rename 成 `/opt/baccarat/releases/<sha>`，並移除所有 write bits。
6. 原子切換 `current`、restart API/worker、檢查兩個 systemd unit 與 `/health` readiness。
7. readiness 失敗時立刻把 `current` 切回先前已驗證相容的 release、restart 並再次檢查 readiness；即使 rollback 成功，deploy command 仍回傳 non-zero。

Release 已存在且 marker 完整時會重用，不會重新 build/migrate。相同 SHA 已 active 時只檢查 readiness。任何 `.staging` 留存都不會自動刪除，避免 migration 狀態不明時重跑；先看 log 與 `.migration-started`，確認 DB 狀態後才人工處理。

部署鎖是 `/opt/baccarat/.deploy.lock`。只有確認沒有 deploy/rollback process 後才能移除 stale lock。

### Optional release hooks

Hooks 必須是 executable，放在 source 的 `deploy/hooks/`：

| Hook | 時機與契約 |
| --- | --- |
| `preflight` | `npm ci` 前執行；檢查 release-specific 外部依賴，non-zero 中止。 |
| `build` | 取代預設 `npm run build`；仍必須產生 server/web production artifacts。 |
| `migrate` | build 後、activation 前執行。必須可觀察、可安全 retry，建議 transaction。 |
| `verify-rollback-compatibility PREVIOUS_RELEASE` | migration 前執行；只有能證明 previous code 可搭配 migration 後 schema 時才回 0。缺少此 hook會拒絕 migration deployment。 |
| `readiness HEALTH_URL` | 取代預設 HTTP `/health` check；systemd active check仍會執行。 |

若 hook 不存在但 `apps/server/package.json` 提供 `db:migrate` script，deploy 會執行 `npm run db:migrate --workspace server`。這是對獨立 migration framework branch 的 feature detection；本流程不依賴尚未 merge 的 migration code。

Migration 必須採 expand/contract：先新增 nullable/defaulted schema，等舊 release 不再需要舊欄位後才在後續 release 移除。若不能保證 previous release 相容，compatibility hook 必須回 non-zero，並改用 coordinated maintenance deployment，不能假裝可自動 rollback。

## 4. Verification and rollback

部署後：

```bash
readlink -f /opt/baccarat/current
curl --fail --silent --show-error http://127.0.0.1:4000/health
sudo systemctl status baccarat-api baccarat-worker
sudo journalctl -u baccarat-api -u baccarat-worker --since '-10 minutes'
```

手動 rollback 預設也只 dry-run，目標為 `previous`：

```bash
sudo deploy/scripts/rollback.sh --dry-run
sudo deploy/scripts/rollback.sh --apply
```

也可指定 immutable SHA：

```bash
sudo deploy/scripts/rollback.sh --target-sha <sha> --dry-run
```

若 active release 執行過 migration，rollback script 只接受該 release marker 中已驗證相容的 SHA。Rollback readiness 失敗時，腳本會把原 active symlink 切回並 restart；之後必須人工確認服務狀態。

## 5. Backup and retention

手動建立 backup：

```bash
sudo -u baccarat /opt/baccarat/current/deploy/scripts/backup.sh create \
  --env-file /etc/baccarat/baccarat.env \
  --backup-dir /var/backups/baccarat
```

輸出是 PostgreSQL custom-format `.dump`、相鄰的 `.sha256`，兩者權限為 `0600`，並使用 temporary file + rename 發佈。`pg_dump` 使用 transactionally consistent snapshot。

Retention 預設只列出、不刪除：

```bash
sudo -u baccarat /opt/baccarat/current/deploy/scripts/backup.sh prune \
  --backup-dir /var/backups/baccarat \
  --keep 14
```

review 清單後才加 `--apply`。安裝的 `baccarat-backup.timer` 每日執行 create，成功後明確使用 `--keep 14 --apply`。確認 timer：

```bash
sudo systemctl start baccarat-backup.service
sudo systemctl enable --now baccarat-backup.timer
systemctl list-timers baccarat-backup.timer
journalctl -u baccarat-backup.service
```

## 6. Restore verification drill

只做 checksum/PG archive 結構驗證：

```bash
sudo -u baccarat /opt/baccarat/current/deploy/scripts/backup.sh verify \
  /var/backups/baccarat/<backup>.dump
```

至少每月做一次真正 restore drill。先建立一次性、空白 scratch database 與專用 role，然後建立 `/etc/baccarat/restore-verify.env`：

```dotenv
ALLOW_RESTORE_VERIFICATION=true
RESTORE_VERIFY_DATABASE_URL=postgres://verify-user:secret@127.0.0.1:5432/baccarat_restore_verify
RESTORE_VERIFY_EXPECTED_DATABASE=baccarat_restore_verify
```

```bash
sudo chown baccarat:baccarat /etc/baccarat/restore-verify.env
sudo chmod 600 /etc/baccarat/restore-verify.env
sudo -u baccarat /opt/baccarat/current/deploy/scripts/backup.sh verify \
  /var/backups/baccarat/<backup>.dump \
  --restore-env-file /etc/baccarat/restore-verify.env
```

Restore verification 只接受 `ALLOW_RESTORE_VERIFICATION=true`，且 scratch DB 必須沒有 user tables；腳本不使用 `--clean` 或 drop。Restore 成功後必須出現至少一個 user table。完成 drill 後刪除整個 scratch database，下次重新建立空 DB。絕對不要把 production `DATABASE_URL` 放進 restore verification env。

災難復原時，先驗證 checksum/archive，再 restore 到新建的空 database；驗證資料後更新 `/etc/baccarat/baccarat.env`，再透過 deploy/rollback 流程 restart。不要直接對現有 production database 執行 `pg_restore --clean`。

## 7. Test the operations tooling

本機不需要 systemd/PostgreSQL；harness 使用 controlled fakes 驗證 atomic activation、readiness failure rollback、migration compatibility gate、credential 不進 argv、retention safety 與 scratch restore：

```bash
npm run test:ops
npm run build
```
