#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TMP_DIR="$(mktemp -d)"
trap 'chmod -R u+w "$TMP_DIR" 2>/dev/null || true; rm -rf "$TMP_DIR"' EXIT
FIXTURE="$TMP_DIR/source"
FAKE_BIN="$TMP_DIR/bin"
DEPLOY_ROOT="$TMP_DIR/opt/baccarat"
ENV_FILE="$TMP_DIR/baccarat.env"
OPS_TEST_LOG="$TMP_DIR/ops.log"
export OPS_TEST_LOG

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_link_target() {
  local link="$1"
  local expected="$2"
  [[ -L "$link" ]] || fail "expected symlink: $link"
  local actual_resolved expected_resolved
  actual_resolved="$(cd "$link" && pwd -P)"
  expected_resolved="$(cd "$expected" && pwd -P)"
  [[ "$actual_resolved" == "$expected_resolved" ]] || fail "$link does not resolve to $expected"
}

mkdir -p "$FIXTURE/apps/server" "$FIXTURE/deploy/hooks" "$FAKE_BIN"
cat > "$FIXTURE/package.json" <<'JSON'
{"name":"fixture","private":true,"scripts":{"build":"true"}}
JSON
cat > "$FIXTURE/package-lock.json" <<'JSON'
{"name":"fixture","lockfileVersion":3,"packages":{}}
JSON
cat > "$FIXTURE/apps/server/package.json" <<'JSON'
{"name":"server","private":true,"scripts":{}}
JSON
cat > "$ENV_FILE" <<'ENV'
NODE_ENV=production
JWT_SECRET=test-only-long-secret
DATABASE_URL=postgres://user:secret@127.0.0.1:5432/test
ENV
chmod 0600 "$ENV_FILE"

cat > "$FAKE_BIN/npm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ -z "${DATABASE_URL:-}" ]]
printf 'npm:%s:%s\n' "$*" "$PWD" >> "$OPS_TEST_LOG"
SH
cat > "$FAKE_BIN/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl:%s\n' "$*" >> "$OPS_TEST_LOG"
SH
cat > "$FAKE_BIN/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl:%s\n' "$*" >> "$OPS_TEST_LOG"
printf '{"ok":true}\n'
SH
chmod +x "$FAKE_BIN"/*

deploy() {
  READINESS_ATTEMPTS=1 \
  READINESS_INTERVAL=0 \
  NPM_BIN="$FAKE_BIN/npm" \
  SYSTEMCTL_BIN="$FAKE_BIN/systemctl" \
  CURL_BIN="$FAKE_BIN/curl" \
    "$ROOT/deploy/scripts/deploy.sh" \
      --source "$FIXTURE" \
      --sha "$1" \
      --deploy-root "$DEPLOY_ROOT" \
      --env-file "$ENV_FILE" \
      --release-user "$(id -un)" \
      --apply
}

deploy aaaaaaa
assert_link_target "$DEPLOY_ROOT/current" "$DEPLOY_ROOT/releases/aaaaaaa"
[[ "$(<"$DEPLOY_ROOT/releases/aaaaaaa/.release-sha")" == "aaaaaaa" ]] || fail "release marker missing"
[[ -f "$DEPLOY_ROOT/releases/aaaaaaa/.migration-complete" ]] || fail "migration marker missing"
[[ ! -w "$DEPLOY_ROOT/releases/aaaaaaa/package.json" ]] || fail "release is not immutable"
npm_call_count="$(grep -c '^npm:' "$OPS_TEST_LOG")"
deploy aaaaaaa
[[ "$(grep -c '^npm:' "$OPS_TEST_LOG")" == "$npm_call_count" ]] || fail "active release was rebuilt"

cat > "$FIXTURE/deploy/hooks/readiness" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$FIXTURE/deploy/hooks/readiness"

if deploy bbbbbbb; then
  fail "failed readiness should make deployment fail"
fi
assert_link_target "$DEPLOY_ROOT/current" "$DEPLOY_ROOT/releases/aaaaaaa"

rm -f "$FIXTURE/deploy/hooks/readiness"
cat > "$FIXTURE/deploy/hooks/migrate" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${DATABASE_URL:-}" == "postgres://user:secret@127.0.0.1:5432/test" ]]
printf 'migrate\n' >> "$OPS_TEST_LOG"
SH
chmod +x "$FIXTURE/deploy/hooks/migrate"

if deploy ccccccc; then
  fail "migration without rollback compatibility hook should fail"
fi
[[ ! -e "$DEPLOY_ROOT/releases/ccccccc" ]] || fail "incompatible migration became a release"
if grep -q '^migrate$' "$OPS_TEST_LOG"; then
  fail "migration ran before compatibility gate"
fi

cat > "$FIXTURE/deploy/hooks/verify-rollback-compatibility" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ -d "$1" ]]
printf 'compatible:%s\n' "$(basename "$1")" >> "$OPS_TEST_LOG"
SH
chmod +x "$FIXTURE/deploy/hooks/verify-rollback-compatibility"
deploy ddddddd
assert_link_target "$DEPLOY_ROOT/current" "$DEPLOY_ROOT/releases/ddddddd"
assert_link_target "$DEPLOY_ROOT/previous" "$DEPLOY_ROOT/releases/aaaaaaa"
grep -q '^compatible:aaaaaaa$' "$OPS_TEST_LOG" || fail "compatibility hook did not run"
grep -q '^migrate$' "$OPS_TEST_LOG" || fail "migration hook did not run"

READINESS_ATTEMPTS=1 \
READINESS_INTERVAL=0 \
SYSTEMCTL_BIN="$FAKE_BIN/systemctl" \
CURL_BIN="$FAKE_BIN/curl" \
  "$ROOT/deploy/scripts/rollback.sh" \
    --deploy-root "$DEPLOY_ROOT" \
    --env-file "$ENV_FILE" \
    --release-user "$(id -un)" \
    --apply
assert_link_target "$DEPLOY_ROOT/current" "$DEPLOY_ROOT/releases/aaaaaaa"
assert_link_target "$DEPLOY_ROOT/previous" "$DEPLOY_ROOT/releases/ddddddd"

printf 'atomic deploy and rollback integration checks passed\n'
