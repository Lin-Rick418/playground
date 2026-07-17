# CI 與必要檢查

Pull request 與 `main` push 會執行 `.github/workflows/pull-request-ci.yml`。Repository 的 branch
protection 應將下列三個 job 設為 required checks：

- `web-unit`
- `quality`
- `dependency-audit`

`web-unit` 平行且優先執行 Vitest/browser-facing unit tests，涵蓋 road derivation、API concurrent
401 refresh consolidation、auth store，以及 WebSocket reconnect/session revocation。job budget 為 2 分鐘；
若超過預算，應先改善安裝/cache 或測試隔離，不可直接把 browser E2E 塞進這個 job。

`quality` 使用 Node.js `22.19.0`、`npm ci` 與 ephemeral PostgreSQL 16，依序執行 repository
static checks、server/web typecheck、production build、server unit tests、release/deploy safety tests，以及真實 HTTP＋PostgreSQL
integration tests。`dependency-audit` 分別檢查 production dependencies 與包含 dev tooling 的完整
dependency tree；任一 high/critical vulnerability 都會讓 check 失敗。

## Player E2E

`.github/workflows/e2e.yml` 以 Chromium、真實 API/worker 與 ephemeral PostgreSQL 驗證玩家登入、
進桌、下注、結算及 history 主流程。它在每次 `main` push 以及每日 02:17（Asia/Taipei）執行，
每個 run 最多 15 分鐘；失敗時保存 7 天 Playwright trace、screenshot、video 與 HTML report。

E2E 初始觀察期不阻擋 pull request。最早於 2026-07-31，在連續 14 天 scheduled/main runs 無
flaky retry、並完成失敗分類與 runtime 檢視後，maintainer 才可把 `pull_request` 加入 workflow trigger，
並將 `player-main-flow` 設為 required check。若仍有 flaky failure，保留獨立排程並開 tracking issue，
不可用增加 retry 掩蓋。

## 依賴更新與 vulnerability audit

Dependabot 每週一檢查 root npm workspace（包含所有 workspaces）與 GitHub Actions。
minor/patch 更新會分組以降低 PR 數量；major 更新保持獨立 PR，必須閱讀 migration guide、
確認 runtime/API 相容性後再合併。Repository maintainer 負責 review；不得只因 PR 是
Dependabot 建立就自動合併。每個更新仍須通過 `quality` 與 `dependency-audit`。

上述 weekly schedule 只控制 version updates；Dependabot security updates 由新 advisory 事件觸發，
不使用 `schedule.interval`。Repository 必須維持 vulnerability alerts 與 automated security fixes
enabled，security update 會依 npm/GitHub Actions ecosystem 分組。

`scheduled-dependency-audit` workflow 每日（09:30 Asia/Taipei）在 main 上重新執行
`audit:prod` 與 `audit:full`，讓新公告的第一個紅燈出現在排程 job 而不是某個
無關 PR 的 CI 上；失敗時會自動開立（或更新）標題為
「Scheduled dependency audit is failing」的 tracking issue。

Dependabot PR 應保留自動產生的 lockfile，並確認：

1. production 與 development dependency 的變更範圍符合 PR 說明；
2. major 或 security update 沒有未處理的 breaking change；
3. CI 全綠，必要時補上受影響功能的 regression test；
4. GitHub Actions 的更新來源仍是可信任的官方／既有 action。

`dependency-audit` 因新公告失敗時，先在同一個 commit 本機執行：

```bash
npm run audit:prod
npm run audit:full
npm audit --json
```

優先升級 direct dependency 或更新 lockfile 到已修補版本，並以正常 PR 通過全部 CI。
不得直接執行或提交未 review 的 `npm audit fix --force`，因為它可能導入 major breaking
change。若只有 transitive dependency 且上游尚無修補版本，請建立或更新 tracking issue，
附上 advisory、production 是否可達、受影響版本、mitigation、owner 與重新檢查日期。

現行政策維持 PR 與 `main` 都阻擋 high/critical vulnerability。只有 maintainer 在確認公告
不影響本專案、已有有效 mitigation 且記錄限期 follow-up 後，才能對單一 PR 做暫時性的
required-check override；不得永久降低 audit level 或移除 `dependency-audit`。修補版本發布後
應立即移除例外並合併更新。

## 本機驗證

```bash
npm ci
npm run check:static
npm run build
npm test
npm test --workspace web
npm run test:release
npm run test:ops
npm run test:deploy
npm run audit:prod
npm run audit:full
```

Integration tests 會建立 users、tables、rounds、bets 與 adjustments 測試資料。不得指向開發共用
或 production database；請使用可丟棄的專用測試 database：

```bash
docker compose up -d postgres
docker compose exec -T postgres createdb -U postgres baccarat_test
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/baccarat_test \
  npm run test:integration
docker compose exec -T postgres dropdb -U postgres baccarat_test
```

CI integration coverage 包含：

- Baccarat payout、natural deal 與 banker third-card table
- Bet debit、insufficient-balance rollback 與 persisted stake invariants
- Settlement payout/balance invariant 與重複 settlement guard
- Login、`/auth/me`、PLAYER-only authorization、session revocation 與 admin route removal
