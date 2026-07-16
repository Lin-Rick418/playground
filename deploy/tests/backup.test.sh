#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
FAKE_BIN="$TMP_DIR/bin"
BACKUP_DIR="$TMP_DIR/backups"
ENV_FILE="$TMP_DIR/baccarat.env"
RESTORE_ENV_FILE="$TMP_DIR/restore.env"
UNSAFE_RESTORE_ENV_FILE="$TMP_DIR/unsafe-restore.env"
INSECURE_ENV_FILE="$TMP_DIR/insecure.env"
ARGV_LOG="$TMP_DIR/argv.log"
RESTORE_STATE="$TMP_DIR/restored"
export ARGV_LOG RESTORE_STATE

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p "$FAKE_BIN"
cat > "$ENV_FILE" <<'ENV'
DATABASE_URL=postgres://backup-user:super-secret-password@127.0.0.1:5432/baccarat
ENV
cat > "$RESTORE_ENV_FILE" <<'ENV'
ALLOW_RESTORE_VERIFICATION=true
RESTORE_VERIFY_DATABASE_URL=postgres://verify-user:another-secret@127.0.0.1:5432/baccarat_restore_verify
RESTORE_VERIFY_EXPECTED_DATABASE=baccarat_restore_verify
ENV
cat > "$UNSAFE_RESTORE_ENV_FILE" <<'ENV'
ALLOW_RESTORE_VERIFICATION=true
RESTORE_VERIFY_DATABASE_URL=postgres://other-user:other-secret@127.0.0.1:5432/baccarat
RESTORE_VERIFY_EXPECTED_DATABASE=baccarat
ENV
cp "$ENV_FILE" "$INSECURE_ENV_FILE"
chmod 0640 "$ENV_FILE" "$RESTORE_ENV_FILE" "$UNSAFE_RESTORE_ENV_FILE"
chmod 0644 "$INSECURE_ENV_FILE"

cat > "$FAKE_BIN/pg_dump" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'pg_dump:%s\n' "$*" >> "$ARGV_LOG"
output=''
for argument in "$@"; do
  case "$argument" in
    --file=*) output="${argument#--file=}" ;;
  esac
done
[[ -n "$output" ]]
printf 'fake custom archive\n' > "$output"
SH
cat > "$FAKE_BIN/pg_restore" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'pg_restore:%s\n' "$*" >> "$ARGV_LOG"
if [[ " $* " != *' --list '* ]]; then
  : > "$RESTORE_STATE"
fi
SH
cat > "$FAKE_BIN/psql" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'psql:%s\n' "$*" >> "$ARGV_LOG"
if [[ -e "$RESTORE_STATE" ]]; then
  printf '4\n'
else
  printf '0\n'
fi
SH
chmod +x "$FAKE_BIN"/*

backup() {
  PG_DUMP_BIN="$FAKE_BIN/pg_dump" \
  PG_RESTORE_BIN="$FAKE_BIN/pg_restore" \
  PSQL_BIN="$FAKE_BIN/psql" \
    "$ROOT/deploy/scripts/backup.sh" "$@"
}

backup create --env-file "$ENV_FILE" --backup-dir "$BACKUP_DIR"
sleep 1
backup create --env-file "$ENV_FILE" --backup-dir "$BACKUP_DIR"
sleep 1
backup create --env-file "$ENV_FILE" --backup-dir "$BACKUP_DIR"

backup_file="$(find "$BACKUP_DIR" -name 'baccarat-*.dump' -type f | sort | head -n 1)"
[[ -n "$backup_file" && -f "${backup_file}.sha256" ]] || fail "backup or checksum missing"
backup verify "$backup_file"
if backup verify "$backup_file" --env-file "$ENV_FILE" --restore-env-file "$UNSAFE_RESTORE_ENV_FILE"; then
  fail "restore verification accepted the production database"
fi
backup verify "$backup_file" --env-file "$ENV_FILE" --restore-env-file "$RESTORE_ENV_FILE"

if backup create --env-file "$INSECURE_ENV_FILE" --backup-dir "$TMP_DIR/insecure-backups"; then
  fail "backup accepted a world-readable credentials file"
fi

if grep -q 'super-secret-password\|another-secret' "$ARGV_LOG"; then
  fail "database credential leaked into command arguments"
fi

before_count="$(find "$BACKUP_DIR" -name 'baccarat-*.dump' -type f | wc -l | tr -d ' ')"
backup prune --backup-dir "$BACKUP_DIR" --keep 2
after_dry_run_count="$(find "$BACKUP_DIR" -name 'baccarat-*.dump' -type f | wc -l | tr -d ' ')"
[[ "$before_count" == "$after_dry_run_count" ]] || fail "retention dry-run deleted backups"
backup prune --backup-dir "$BACKUP_DIR" --keep 2 --apply
after_apply_count="$(find "$BACKUP_DIR" -name 'baccarat-*.dump' -type f | wc -l | tr -d ' ')"
[[ "$after_apply_count" == "2" ]] || fail "retention apply did not keep exactly two backups"

printf 'backup, retention, and restore verification checks passed\n'
