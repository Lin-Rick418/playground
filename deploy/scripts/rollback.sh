#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/baccarat}"
ENV_FILE="${ENV_FILE:-/etc/baccarat/baccarat.env}"
RELEASE_USER="${RELEASE_USER:-baccarat}"
TARGET_SHA=""
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/health}"
READINESS_ATTEMPTS="${READINESS_ATTEMPTS:-10}"
READINESS_INTERVAL="${READINESS_INTERVAL:-2}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
CURL_BIN="${CURL_BIN:-curl}"
APPLY=false

usage() {
  cat <<'USAGE'
Usage: rollback.sh [--target-sha SHA] [options]

Defaults to the `previous` symlink and performs no changes without --apply.
Rollback is refused when the active release ran migrations without evidence
that the requested target was verified as compatible.

Options:
  --target-sha SHA      Immutable release to reactivate (default: previous)
  --deploy-root PATH    Deployment root (default: /opt/baccarat)
  --env-file PATH       Protected production env file
  --release-user USER   Service user (default: baccarat)
  --health-url URL      API readiness URL
  --apply               Perform rollback
  --dry-run             Validate and print the rollback plan (default)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-sha)
      TARGET_SHA="$2"
      shift 2
      ;;
    --deploy-root)
      DEPLOY_ROOT="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --release-user)
      RELEASE_USER="$2"
      shift 2
      ;;
    --health-url)
      HEALTH_URL="$2"
      shift 2
      ;;
    --apply)
      APPLY=true
      shift
      ;;
    --dry-run)
      APPLY=false
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

[[ -n "$RELEASE_USER" ]] || die "release user cannot be empty"
[[ "$READINESS_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "READINESS_ATTEMPTS must be a positive integer"
[[ "$READINESS_INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "READINESS_INTERVAL must be non-negative"

require_command node
[[ -d "$DEPLOY_ROOT" ]] || die "deployment root not found: $DEPLOY_ROOT"
DEPLOY_ROOT="$(cd "$DEPLOY_ROOT" && pwd -P)"
CURRENT_LINK="$DEPLOY_ROOT/current"
PREVIOUS_LINK="$DEPLOY_ROOT/previous"
LOCK_DIR="$DEPLOY_ROOT/.deploy.lock"
[[ -L "$CURRENT_LINK" ]] || die "current release symlink not found: $CURRENT_LINK"
if [[ -e "$PREVIOUS_LINK" && ! -L "$PREVIOUS_LINK" ]]; then
  die "$PREVIOUS_LINK must be a symlink, not a file or directory"
fi
active_release="$(resolve_link "$CURRENT_LINK")"

if [[ -n "$TARGET_SHA" ]]; then
  [[ "$TARGET_SHA" =~ ^[0-9a-f]{7,64}$ ]] || die "target SHA must be 7-64 lowercase hexadecimal characters"
  target_release="$DEPLOY_ROOT/releases/$TARGET_SHA"
else
  [[ -L "$PREVIOUS_LINK" ]] || die "previous release symlink not found: $PREVIOUS_LINK"
  target_release="$(resolve_link "$PREVIOUS_LINK")"
  TARGET_SHA="$(basename "$target_release")"
fi

[[ -d "$target_release" && -f "$target_release/.migration-complete" && -f "$target_release/.release-sha" ]] ||
  die "target is not a complete release"
target_release="$(cd "$target_release" && pwd -P)"
[[ "$target_release" != "$active_release" ]] || die "target release is already active"
[[ "$(<"$target_release/.release-sha")" == "$TARGET_SHA" ]] || die "target release marker mismatch"

active_migration_mode="none"
if [[ -f "$active_release/.migration-mode" ]]; then
  active_migration_mode="$(<"$active_release/.migration-mode")"
fi
if [[ "$active_migration_mode" != "none" ]]; then
  [[ -f "$active_release/.rollback-compatible-from" ]] || die "active release has no rollback compatibility evidence"
  [[ "$(<"$active_release/.rollback-compatible-from")" == "$TARGET_SHA" ]] ||
    die "target $TARGET_SHA was not verified as compatible with the active migration"
fi

if [[ "$APPLY" != true ]]; then
  log "DRY RUN: would atomically switch current from $(basename "$active_release") to $TARGET_SHA"
  log "DRY RUN: services would restart and readiness failure would restore the active release"
  exit 0
fi

require_command "$SYSTEMCTL_BIN"
require_command "$CURL_BIN"
load_env_file "$ENV_FILE"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  die "another deployment may be running; inspect stale lock: $LOCK_DIR"
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"
cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

run_as_release_user() {
  if [[ "$(id -un)" == "$RELEASE_USER" ]]; then
    "$@"
    return
  fi
  [[ "$(id -u)" == "0" ]] || die "run as $RELEASE_USER or root"
  require_command runuser
  runuser --preserve-environment -u "$RELEASE_USER" -- "$@"
}

readiness_once() {
  "$SYSTEMCTL_BIN" is-active --quiet baccarat-api
  "$SYSTEMCTL_BIN" is-active --quiet baccarat-worker
  if [[ -x "$target_release/deploy/hooks/readiness" ]]; then
    (cd "$target_release" && run_as_release_user "$target_release/deploy/hooks/readiness" "$HEALTH_URL")
  else
    "$CURL_BIN" --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null
  fi
}

wait_until_ready() {
  local attempt
  for ((attempt = 1; attempt <= READINESS_ATTEMPTS; attempt += 1)); do
    readiness_once && return 0
    if (( attempt < READINESS_ATTEMPTS )); then
      sleep "$READINESS_INTERVAL"
    fi
  done
  return 1
}

log "atomically rolling back to $TARGET_SHA"
atomic_symlink "$target_release" "$CURRENT_LINK"
if "$SYSTEMCTL_BIN" restart baccarat-api baccarat-worker && wait_until_ready; then
  atomic_symlink "$active_release" "$PREVIOUS_LINK"
  log "rollback to $TARGET_SHA is active and ready"
  exit 0
fi

log "rollback readiness failed; restoring $(basename "$active_release")"
atomic_symlink "$active_release" "$CURRENT_LINK"
"$SYSTEMCTL_BIN" restart baccarat-api baccarat-worker || true
die "rollback failed and the original release was reactivated; verify service health manually"
