#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

ENV_FILE="${ENV_FILE:-/etc/baccarat/baccarat.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/baccarat}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
PG_RESTORE_BIN="${PG_RESTORE_BIN:-pg_restore}"
PSQL_BIN="${PSQL_BIN:-psql}"
KEEP_COUNT="${KEEP_COUNT:-14}"
APPLY=false
DRY_RUN=false
RESTORE_ENV_FILE=""

usage() {
  cat <<'USAGE'
Usage:
  backup.sh create [--env-file PATH] [--backup-dir PATH] [--dry-run]
  backup.sh prune [--backup-dir PATH] [--keep COUNT] [--apply]
  backup.sh verify BACKUP.dump [--env-file PROD_ENV] [--restore-env-file PATH]

Commands:
  create  Create an atomic PostgreSQL custom-format dump and SHA-256 file.
  prune   Show backups outside retention; deletion requires explicit --apply.
  verify  Verify checksum/archive. With --restore-env-file, restore into an
          explicitly enabled, empty scratch database and verify user tables.

Database URLs are loaded from protected env files and passed to libpq through
PGDATABASE. Credentials are never placed in command arguments.
USAGE
}

[[ $# -gt 0 ]] || {
  usage
  exit 1
}
COMMAND="$1"
shift
BACKUP_FILE=""

if [[ "$COMMAND" == "verify" && $# -gt 0 && "$1" != --* ]]; then
  BACKUP_FILE="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --backup-dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    --keep)
      KEEP_COUNT="$2"
      shift 2
      ;;
    --restore-env-file)
      RESTORE_ENV_FILE="$2"
      shift 2
      ;;
    --apply)
      APPLY=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

create_backup() {
  [[ -f "$ENV_FILE" ]] || die "environment file not found: $ENV_FILE"
  if [[ "$DRY_RUN" == true ]]; then
    log "DRY RUN: would create a custom-format dump in $BACKUP_DIR using credentials from $ENV_FILE"
    return
  fi

  require_command "$PG_DUMP_BIN"
  load_env_file "$ENV_FILE"
  [[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is required in $ENV_FILE"
  mkdir -p -m 0700 "$BACKUP_DIR"
  chmod 0700 "$BACKUP_DIR"

  local timestamp final_file temporary_file checksum_file temporary_checksum
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  final_file="$BACKUP_DIR/baccarat-${timestamp}-$$-${RANDOM}.dump"
  [[ ! -e "$final_file" && ! -e "${final_file}.sha256" ]] || die "backup filename collision: $final_file"
  checksum_file="${final_file}.sha256"
  temporary_file="$(mktemp "$BACKUP_DIR/.baccarat-backup.XXXXXX")"
  temporary_checksum="$(mktemp "$BACKUP_DIR/.baccarat-checksum.XXXXXX")"

  cleanup_backup_temps() {
    rm -f "$temporary_file" "$temporary_checksum"
  }
  trap cleanup_backup_temps EXIT INT TERM

  log "creating PostgreSQL backup with credentials from protected env file"
  PGDATABASE="$DATABASE_URL" "$PG_DUMP_BIN" \
    --format=custom \
    --no-owner \
    --no-privileges \
    --file="$temporary_file"
  [[ -s "$temporary_file" ]] || die "pg_dump produced an empty backup"

  chmod 0600 "$temporary_file"
  mv "$temporary_file" "$final_file"
  checksum_create "$final_file" "$temporary_checksum"
  chmod 0600 "$temporary_checksum"
  mv "$temporary_checksum" "$checksum_file"
  trap - EXIT INT TERM
  log "backup created: $final_file"
}

prune_backups() {
  [[ "$KEEP_COUNT" =~ ^[1-9][0-9]*$ ]] || die "--keep must be a positive integer"
  [[ -d "$BACKUP_DIR" ]] || {
    log "backup directory does not exist; nothing to prune: $BACKUP_DIR"
    return
  }

  local -a backups=()
  local -a candidates=()
  local file index
  shopt -s nullglob
  candidates=("$BACKUP_DIR"/baccarat-*.dump)
  shopt -u nullglob
  if (( ${#candidates[@]} > 0 )); then
    while IFS= read -r file; do
      backups+=("$file")
    done < <(printf '%s\n' "${candidates[@]}" | sort -r)
  fi

  if (( ${#backups[@]} <= KEEP_COUNT )); then
    log "retention satisfied: ${#backups[@]} backup(s), keeping $KEEP_COUNT"
    return
  fi

  for ((index = KEEP_COUNT; index < ${#backups[@]}; index += 1)); do
    file="${backups[$index]}"
    if [[ "$APPLY" == true ]]; then
      rm -f -- "$file" "${file}.sha256"
      log "deleted expired backup: $file"
    else
      log "DRY RUN: would delete $file and ${file}.sha256"
    fi
  done

  if [[ "$APPLY" != true ]]; then
    log "no files deleted; rerun prune with --apply after reviewing the list"
  fi
}

verify_backup() {
  local table_count restore_verify_database_url restore_verify_expected_database
  [[ -n "$BACKUP_FILE" ]] || die "verify requires a backup file"
  [[ -f "$BACKUP_FILE" ]] || die "backup not found: $BACKUP_FILE"
  [[ -f "${BACKUP_FILE}.sha256" ]] || die "checksum file not found: ${BACKUP_FILE}.sha256"
  require_command "$PG_RESTORE_BIN"

  checksum_verify "${BACKUP_FILE}.sha256"
  "$PG_RESTORE_BIN" --list "$BACKUP_FILE" >/dev/null
  log "checksum and pg_restore archive listing verified"

  [[ -n "$RESTORE_ENV_FILE" ]] || return 0
  require_command "$PSQL_BIN"
  require_command node
  load_env_file "$RESTORE_ENV_FILE"
  [[ "${ALLOW_RESTORE_VERIFICATION:-false}" == "true" ]] ||
    die "restore verification requires ALLOW_RESTORE_VERIFICATION=true"
  [[ -n "${RESTORE_VERIFY_DATABASE_URL:-}" ]] ||
    die "RESTORE_VERIFY_DATABASE_URL is required in $RESTORE_ENV_FILE"
  [[ -n "${RESTORE_VERIFY_EXPECTED_DATABASE:-}" ]] ||
    die "RESTORE_VERIFY_EXPECTED_DATABASE is required in $RESTORE_ENV_FILE"

  restore_verify_database_url="$RESTORE_VERIFY_DATABASE_URL"
  restore_verify_expected_database="$RESTORE_VERIFY_EXPECTED_DATABASE"
  load_env_file "$ENV_FILE"
  [[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is required in $ENV_FILE"
  PRODUCTION_DATABASE_URL="$DATABASE_URL" \
  RESTORE_VERIFY_DATABASE_URL="$restore_verify_database_url" \
  RESTORE_VERIFY_EXPECTED_DATABASE="$restore_verify_expected_database" \
    node - <<'NODE'
let productionUrl;
let restoreUrl;
try {
  productionUrl = new URL(process.env.PRODUCTION_DATABASE_URL);
  restoreUrl = new URL(process.env.RESTORE_VERIFY_DATABASE_URL);
} catch {
  console.error("production or restore verification database URL is invalid");
  process.exit(1);
}
const expectedDatabase = process.env.RESTORE_VERIFY_EXPECTED_DATABASE;
const restoreDatabase = decodeURIComponent(restoreUrl.pathname.replace(/^\//, ""));
const productionDatabase = decodeURIComponent(productionUrl.pathname.replace(/^\//, ""));

if (!restoreDatabase || restoreDatabase !== expectedDatabase) {
  console.error("restore verification database does not match RESTORE_VERIFY_EXPECTED_DATABASE");
  process.exit(1);
}

const normalizeHost = (url) => `${url.hostname === "localhost" ? "127.0.0.1" : url.hostname}:${url.port || "5432"}`;
if (normalizeHost(productionUrl) === normalizeHost(restoreUrl) && productionDatabase === restoreDatabase) {
  console.error("restore verification database resolves to the production database");
  process.exit(1);
}
NODE
  RESTORE_VERIFY_DATABASE_URL="$restore_verify_database_url"

  table_count="$(
    PGDATABASE="$RESTORE_VERIFY_DATABASE_URL" "$PSQL_BIN" -v ON_ERROR_STOP=1 -Atc \
      "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema');"
  )"
  [[ "$table_count" == "0" ]] || die "scratch restore database must be empty; found $table_count user table(s)"

  log "restoring backup into explicitly enabled scratch database"
  PGDATABASE="$RESTORE_VERIFY_DATABASE_URL" "$PG_RESTORE_BIN" \
    --exit-on-error \
    --no-owner \
    --no-privileges \
    "$BACKUP_FILE"

  table_count="$(
    PGDATABASE="$RESTORE_VERIFY_DATABASE_URL" "$PSQL_BIN" -v ON_ERROR_STOP=1 -Atc \
      "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema');"
  )"
  [[ "$table_count" =~ ^[1-9][0-9]*$ ]] || die "restore completed without any user tables"
  log "restore verification passed with $table_count user table(s)"
}

case "$COMMAND" in
  create)
    create_backup
    ;;
  prune)
    prune_backups
    ;;
  verify)
    verify_backup
    ;;
  *)
    die "unknown command: $COMMAND"
    ;;
esac
