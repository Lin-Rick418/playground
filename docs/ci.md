# CI 與必要檢查

Pull request 與 `main` push 會執行 `.github/workflows/pull-request-ci.yml`。目前檔案實際定義兩個 job：

- `web-unit`：Vitest 與 browser-facing unit tests，timeout 2 分鐘。
- `quality`：static/typecheck、lint、production build、contracts/server unit tests、release/deploy safety tests、真實 HTTP＋PostgreSQL integration tests，timeout 20 分鐘。

兩個 job 可並行執行，使用固定 Node.js `22.19.0` 與 `npm ci`；quality 使用 ephemeral PostgreSQL 16。
Branch protection 應依實際 job 名稱設定；本文件不代表已查證 GitHub 遠端的 protection 設定。

**目前沒有 `dependency-audit` job，也沒有 每日 audit 與失敗時自動開 tracking issue 是可另行實作的改善項目，目前 repository 沒有相應 workflow；不能依賴它發現新 advisory。

Dependabot PR 應保留自動產生的 lockfile，並確認：

1. production 與 development dependency 的變更範圍符合 PR 說明；
2. major 或 security update 沒有未處理的 breaking change；
3. CI 全綠，必要時補上受影響功能的 regression test；
4. GitHub Actions 的更新來源仍是可信任的官方／既有 action。

依賴安全性檢查或新 advisory 出現時，可在同一個 commit 本機執行：

```bash
npm run audit:prod
npm run audit:full
npm audit --json
```

優先升級 direct dependency 或更新 lockfile 到已修補版本，並以正常 PR 通過全部 CI。
不得直接執行或提交未 review 的 `npm audit fix --force`，因為它可能導入 major breaking
change。若只有 transitive dependency 且上游尚無修補版本，請建立或更新 tracking issue，
附上 advisory、production 是否可達、受影響版本、mitigation、owner 與重新檢查日期。

本機 audit 預設對 high/critical 回傳失敗。不要為了通過檢查降低 audit level；若之後加入 CI audit，需明確記錄實際 job、觸發條件與例外處理，不把預定政策當成現有自動化。

## 本機驗證

```bash
npm ci
npm run check:static
npm run lint
npm run build
npm test
npm test --workspace web
npm run test:release
npm run test:ops
npm run test:deploy
npm run audit:prod
npm run audit:full
```

`npm test` 只執行 contracts 與 server；web 必須另外執行 `npm test --workspace web`。本機 `.env` 可能影響 env tests，應以明確的測試環境值隔離，不要移除 production guard。

Integration tests 會建立 users、tables、rounds、bets 與 adjustments 測試資料。不得指向開發共用
或 production database；請使用可丟棄的專用測試 database：

```bash
docker compose up -d postgres
docker compose exec -T postgres createdb -U postgres baccarat_core_api_test_local
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/baccarat_core_api_test_local \
  npm run test:integration
docker compose exec -T postgres dropdb -U postgres baccarat_core_api_test_local
```

Migration runner suite 另有 `baccarat_migration_test_*` 的名稱檢查，請讀取 `migration-runner.integration.test.ts` 的專用環境旗標與命名要求，不要沿用開發 DB 或 core API DB 名稱。

CI integration coverage 包含：

- Baccarat payout、natural deal 與 banker third-card table
- Bet debit、insufficient-balance rollback 與 persisted stake invariants
- Settlement payout/balance invariant 與重複 settlement guard
- Login、`/auth/me`、PLAYER-only authorization、session revocation 與 admin route removal

- Mines／Plinko／Hi-Lo 的重試、錢包／曝險與交易一致性；實際 cases 以 `apps/server/test/integration/core-api.test.ts` 為準。
