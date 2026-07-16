# Production Rollback

rollback 的目標是把 code、systemd unit 與必要的 env 一起回到上一個已驗證版本；active release 本身不可被修改。

## 前置檢查

1. 找出上一個 release，確認它位於 `/opt/baccarat/releases` 且不是目前 target。
2. 檢查該版本的 release notes 與 database 相容性。切 symlink 不會回復 schema 或資料。
3. 保留最近的 `pg_dump`，並記錄目前 `readlink -f /opt/baccarat/current`。
4. 如果事故只影響 web asset，可先評估是否需要停止 API/worker；其餘情況使用下面的完整流程。

## 完整 rollback

設定明確的 target，不要用未檢查的 glob 或「上一個目錄」推斷：

```bash
PREVIOUS_RELEASE=/opt/baccarat/releases/<known-good-release>
test -d "$PREVIOUS_RELEASE"
test "$(readlink -f "$PREVIOUS_RELEASE")" != "$(readlink -f /opt/baccarat/current)"
```

先停止 worker，避免切版期間建立新 round，再停止 API：

```bash
sudo systemctl stop baccarat-worker
sudo systemctl stop baccarat-api
```

從 known-good release 回復 unit，接著原子替換 `current`：

```bash
sudo install -o root -g root -m 0644 \
  "$PREVIOUS_RELEASE/deploy/systemd/baccarat-api.service" \
  /etc/systemd/system/baccarat-api.service
sudo install -o root -g root -m 0644 \
  "$PREVIOUS_RELEASE/deploy/systemd/baccarat-worker.service" \
  /etc/systemd/system/baccarat-worker.service

ROLLBACK_LINK="/opt/baccarat/.rollback-$(date +%s)"
sudo ln -s "$PREVIOUS_RELEASE" "$ROLLBACK_LINK"
sudo chown -h root:deployer "$ROLLBACK_LINK"
sudo mv -Tf "$ROLLBACK_LINK" /opt/baccarat/current

sudo systemctl daemon-reload
sudo /opt/baccarat/current/deploy/scripts/validate-install-permissions.sh
sudo systemd-analyze verify \
  /etc/systemd/system/baccarat-api.service \
  /etc/systemd/system/baccarat-worker.service
```

依序啟動 API、健康檢查，再啟動 worker：

```bash
sudo systemctl start baccarat-api
curl --fail http://127.0.0.1:4000/health
sudo systemctl start baccarat-worker
sudo systemctl --no-pager --full status baccarat-api baccarat-worker
journalctl -u baccarat-api -u baccarat-worker --since '10 minutes ago'
```

最後驗證登入、WebSocket、讀取桌況、下注、round transition 與 settlement；若任一檢查失敗，保持 worker 停止並蒐集 journal，不要反覆重啟造成狀態持續變動。

## Env rollback

env 不在 release 內。若變更過 `/etc/baccarat/baccarat.env`，從受控 secret backup 回復，並重新套用 ownership/mode：

```bash
sudo install -o root -g baccarat -m 0640 \
  /secure/backup/baccarat.env \
  /etc/baccarat/baccarat.env
sudo /opt/baccarat/current/deploy/scripts/validate-install-permissions.sh
sudo systemctl restart baccarat-api baccarat-worker
```

不要把 env 複製進 release、Git repository 或 journal。

## Database rollback boundary

目前啟動流程會執行 additive `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`，但未來 migration 仍必須遵守 expand/contract 與至少一版 backward compatibility。code rollback 不會移除 column、回復 balance 或撤銷已 settlement 的 round。

只有確認需要 data restore 時才進入 maintenance window、停止 API/worker，並由 DBA 從已驗證 backup 回復。不要為了 code rollback 直接執行 destructive schema rollback。

## Sandbox-only regression

若新 hardening directive 導致 `EPERM`、DNS、PostgreSQL 或 Node 啟動失敗，優先回復 known-good release 的完整 unit。不要用永久 drop-in 關閉全部 sandbox。若為了止血建立暫時 drop-in，必須記錄單一被放寬的 directive、設定到期時間，並在 staging 補足相容性測試後移除。
