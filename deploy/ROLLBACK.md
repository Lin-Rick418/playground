# Production rollback

Rollback 只切換到已完成、immutable 且已驗證 database compatibility 的 release。它不會回復 schema、balance、round 或其他 production data。

## 前置檢查

1. 記錄 `readlink -f /opt/baccarat/current`、事故時間、active SHA 與最近 deploy log。
2. 確認 target 位於 `/opt/baccarat/releases/<sha>`，marker 完整，且不是目前 release。
3. 檢查 active release 的 `.migration-mode` 與 `.rollback-compatible-from`。如果 target 未被 migration compatibility gate 驗證，不得自動 rollback。
4. 保留最近的已驗證 backup；若 schema/data 已不相容，改進 maintenance window 與 DBA recovery，不要強切舊 code。

## 使用 atomic rollback

預設只 dry-run：

```bash
sudo deploy/scripts/rollback.sh --dry-run
sudo deploy/scripts/rollback.sh --apply
```

預設 target 是 `previous` symlink。也可以指定已確認的 immutable SHA：

```bash
sudo deploy/scripts/rollback.sh --target-sha <known-good-sha> --dry-run
sudo deploy/scripts/rollback.sh --target-sha <known-good-sha> --apply
```

腳本會取得 deployment lock、原子切換 `current`、restart API/worker 並執行 readiness。若 target readiness 失敗，會重新啟用原 active release；command 仍回傳 non-zero，必須人工確認服務。

## 驗證

```bash
readlink -f /opt/baccarat/current
sudo /opt/baccarat/current/deploy/scripts/validate-install-permissions.sh
sudo systemd-analyze verify /etc/systemd/system/baccarat-*.service
sudo systemctl --no-pager --full status baccarat-api baccarat-worker
curl --fail http://127.0.0.1:4000/health
journalctl -u baccarat-api -u baccarat-worker --since '10 minutes ago'
```

接著驗證登入、refresh rotation、WebSocket、桌況、下注、round transition、settlement 與財務 reconciliation。任一核心檢查失敗時停止 worker 並蒐集 journal，不要反覆 restart。

## Env 與 database 邊界

Env 不在 release 中。若必須回復 secret/config，從受控 secret backup 安裝為 `root:baccarat`、mode `0640`，再執行 permission validator 與 restart：

```bash
sudo install -o root -g baccarat -m 0640 \
  /secure/backup/baccarat.env /etc/baccarat/baccarat.env
sudo /opt/baccarat/current/deploy/scripts/validate-install-permissions.sh
sudo systemctl restart baccarat-api baccarat-worker
```

API、worker、bootstrap 與 seed 都不執行 DDL；schema 只由 versioned migration 更新，且 runtime 會驗證 version 與 live fingerprint。Code rollback 不等於 database rollback。只有確認需要 data restore 時，才在 maintenance window 停止 API/worker，並由 DBA restore 到新 database 後驗證與切換；不要對 production 直接執行 destructive schema rollback 或 `pg_restore --clean`。

若事故由 systemd sandbox directive 或 Node upgrade 引起，回復 known-good release 內的完整 unit。不要永久關閉所有 hardening；臨時 drop-in 必須只放寬單一 directive、記錄到期時間，並在 staging 補足 API、WebSocket、DNS、PostgreSQL、worker transition 與 graceful restart 測試。
