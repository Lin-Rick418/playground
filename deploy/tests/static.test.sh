#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

for script in \
  "$ROOT/deploy/scripts/deploy.sh" \
  "$ROOT/deploy/scripts/rollback.sh" \
  "$ROOT/deploy/scripts/backup.sh" \
  "$ROOT/deploy/scripts/lib/common.sh"; do
  bash -n "$script"
done

grep -q '^set -euo pipefail$' "$ROOT/deploy/scripts/deploy.sh" || fail "deploy.sh must use strict mode"
grep -q '^set -euo pipefail$' "$ROOT/deploy/scripts/backup.sh" || fail "backup.sh must use strict mode"
grep -q '^set -euo pipefail$' "$ROOT/deploy/scripts/rollback.sh" || fail "rollback.sh must use strict mode"
grep -q 'atomic_symlink "$RELEASE_DIR" "$CURRENT_LINK"' "$ROOT/deploy/scripts/deploy.sh" || fail "missing atomic activation"
grep -q 'chown -R "root:$DEPLOY_GROUP"' "$ROOT/deploy/scripts/deploy.sh" || fail "release is not frozen as root-owned"
grep -q 'BUILD_COMMIT_SHA' "$ROOT/deploy/scripts/deploy.sh" || fail "deploy does not preserve verified build metadata"
grep -q 'verify-rollback-compatibility' "$ROOT/deploy/scripts/deploy.sh" || fail "missing rollback compatibility gate"
grep -q 'db:migrate' "$ROOT/deploy/scripts/deploy.sh" || fail "missing migration feature detection"
grep -q 'PGDATABASE="$DATABASE_URL"' "$ROOT/deploy/scripts/backup.sh" || fail "database URL must be passed via environment"
grep -q "connect-src 'self';" "$ROOT/deploy/nginx/baccarat.conf" || fail "CSP must restrict connections to the deployment origin"
if grep -Eq "connect-src[^;]*[[:space:]](ws:|wss:)([[:space:]]|;)" "$ROOT/deploy/nginx/baccarat.conf"; then
  fail "CSP must not allow arbitrary WebSocket origins"
fi

if grep -REn 'eval|env \$\(cat|xargs|--dbname=.*DATABASE_URL|--dbname=.*RESTORE_VERIFY_DATABASE_URL' \
  "$ROOT/deploy/scripts"; then
  fail "unsafe secret parsing or database credentials in argv"
fi

"$ROOT/deploy/scripts/deploy.sh" \
  --source "$ROOT" \
  --sha aaaaaaa \
  --deploy-root "$TMP_DIR/deploy" \
  --dry-run
[[ ! -e "$TMP_DIR/deploy" ]] || fail "deploy dry-run changed filesystem state"

"$ROOT/deploy/scripts/backup.sh" create \
  --env-file "$ROOT/deploy/env/baccarat.env.example" \
  --backup-dir "$TMP_DIR/backups" \
  --dry-run
[[ ! -e "$TMP_DIR/backups" ]] || fail "backup dry-run changed filesystem state"

printf 'static safety checks passed\n'
