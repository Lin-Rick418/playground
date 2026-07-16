# CI 與必要檢查

Pull request 與 `master` push 會執行 `.github/workflows/pull-request-ci.yml`。Repository 的 branch
protection 應將下列兩個 job 設為 required checks：

- `quality`
- `dependency-audit`

`quality` 使用 Node.js `22.19.0`、`npm ci` 與 ephemeral PostgreSQL 16，依序執行 repository
static checks、server/web typecheck、production build、unit tests，以及真實 HTTP＋PostgreSQL
integration tests。`dependency-audit` 分別檢查 production dependencies 與包含 dev tooling 的完整
dependency tree；任一 high/critical vulnerability 都會讓 check 失敗。

## 本機驗證

```bash
npm ci
npm run check:static
npm run build
npm test
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
