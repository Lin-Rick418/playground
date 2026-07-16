#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/baccarat}"
ENV_FILE="${ENV_FILE:-/etc/baccarat/baccarat.env}"
SOURCE_DIR="${SOURCE_DIR:-$(pwd -P)}"
RELEASE_SHA="${RELEASE_SHA:-}"
BUILD_USER="${BUILD_USER:-${SUDO_USER:-$(id -un)}}"
DEPLOY_GROUP="${DEPLOY_GROUP:-deployer}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/health}"
READINESS_ATTEMPTS="${READINESS_ATTEMPTS:-10}"
READINESS_INTERVAL="${READINESS_INTERVAL:-2}"
NPM_BIN="${NPM_BIN:-npm}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
CURL_BIN="${CURL_BIN:-curl}"
APPLY=false
PRODUCTION_ENV_LOADED=false

usage() {
  cat <<'USAGE'
Usage: deploy.sh [options]

Creates /opt/baccarat/releases/<sha> and atomically activates the `current`
symlink. The default is a non-mutating dry-run; pass --apply to deploy.

Options:
  --source PATH          Source checkout or extracted artifact (default: cwd)
  --sha SHA              7-64 lowercase hexadecimal release identifier
  --deploy-root PATH     Deployment root (default: /opt/baccarat)
  --env-file PATH        Protected production env file
  --build-user USER      Non-runtime user that runs build and hooks (default: SUDO_USER)
  --release-user USER    Deprecated alias for --build-user
  --health-url URL       API readiness URL
  --apply                Perform the deployment
  --dry-run              Print the plan without changing state (default)
  -h, --help             Show this help

Optional release hooks:
  deploy/hooks/preflight
  deploy/hooks/build
  deploy/hooks/migrate
  deploy/hooks/verify-rollback-compatibility PREVIOUS_RELEASE
  deploy/hooks/readiness HEALTH_URL

If no migrate hook exists, the script feature-detects the server workspace's
`db:migrate` package script. A migration requires the rollback compatibility
hook whenever a previous release is active.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_DIR="$2"
      shift 2
      ;;
    --sha)
      RELEASE_SHA="$2"
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
    --build-user|--release-user)
      BUILD_USER="$2"
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

[[ -d "$SOURCE_DIR" ]] || die "source directory not found: $SOURCE_DIR"
SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd -P)"
[[ -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/package-lock.json" ]] ||
  die "source must contain package.json and package-lock.json"

if [[ -z "$RELEASE_SHA" ]]; then
  require_command git
  RELEASE_SHA="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
fi

[[ "$RELEASE_SHA" =~ ^[0-9a-f]{7,64}$ ]] || die "release SHA must be 7-64 lowercase hexadecimal characters"
[[ -n "$BUILD_USER" ]] || die "build user cannot be empty"
case "$BUILD_USER" in
  baccarat|baccarat-api|baccarat-worker|baccarat-backup)
    die "build user must not be a runtime service account: $BUILD_USER"
    ;;
esac
[[ "$READINESS_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "READINESS_ATTEMPTS must be a positive integer"
[[ "$READINESS_INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "READINESS_INTERVAL must be non-negative"

RELEASES_DIR="$DEPLOY_ROOT/releases"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_SHA"
STAGING_DIR="$RELEASES_DIR/.${RELEASE_SHA}.staging"
CURRENT_LINK="$DEPLOY_ROOT/current"
PREVIOUS_LINK="$DEPLOY_ROOT/previous"
LOCK_DIR="$DEPLOY_ROOT/.deploy.lock"

if [[ "$APPLY" != true ]]; then
  log "DRY RUN: source=$SOURCE_DIR"
  log "DRY RUN: release=$RELEASE_DIR"
  log "DRY RUN: preflight -> build -> compatibility check -> migrate -> atomic activation -> readiness"
  log "DRY RUN: failed activation would restore the previous compatible release"
  exit 0
fi

require_command node
require_command tar
require_command "$NPM_BIN"
require_command "$SYSTEMCTL_BIN"
require_command "$CURL_BIN"
(
  load_env_file "$ENV_FILE"
  [[ "${NODE_ENV:-production}" == "production" ]] || die "NODE_ENV must be production"
  [[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is required in $ENV_FILE"
  [[ -n "${JWT_SECRET:-}" && "${JWT_SECRET:-}" != "change-me" && "${JWT_SECRET:-}" != "replace-with-a-long-random-secret" ]] ||
    die "JWT_SECRET must be replaced before deployment"
)
unset DATABASE_URL JWT_SECRET PGPASSWORD PGDATABASE RESTORE_VERIFY_DATABASE_URL

if [[ "$DEPLOY_ROOT" == "/opt/baccarat" ]]; then
  [[ "$(id -u)" == "0" ]] || die "production deployment must run as root"
  getent group "$DEPLOY_GROUP" >/dev/null || die "deployment group not found: $DEPLOY_GROUP"
  id "$BUILD_USER" >/dev/null 2>&1 || die "build user not found: $BUILD_USER"
  [[ "$(id -u "$BUILD_USER")" != "0" ]] || die "production build must not run as root; use --build-user"
  id -nG "$BUILD_USER" | tr ' ' '\n' | grep -Fxq "$DEPLOY_GROUP" ||
    die "build user $BUILD_USER is not a member of $DEPLOY_GROUP"
  install -d -o root -g "$DEPLOY_GROUP" -m 0755 "$DEPLOY_ROOT" "$RELEASES_DIR"
else
  mkdir -p "$RELEASES_DIR"
fi
DEPLOY_ROOT="$(cd "$DEPLOY_ROOT" && pwd -P)"
RELEASES_DIR="$DEPLOY_ROOT/releases"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_SHA"
STAGING_DIR="$RELEASES_DIR/.${RELEASE_SHA}.staging"
CURRENT_LINK="$DEPLOY_ROOT/current"
PREVIOUS_LINK="$DEPLOY_ROOT/previous"
LOCK_DIR="$DEPLOY_ROOT/.deploy.lock"
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
  if [[ "$(id -un)" == "$BUILD_USER" ]]; then
    "$@"
    return
  fi

  [[ "$(id -u)" == "0" ]] || die "run as $BUILD_USER or root"
  require_command runuser
  runuser -u "$BUILD_USER" -- "$@"
}

run_in_release() {
  local release="$1"
  shift
  (cd "$release" && run_as_release_user "$@")
}

own_staging_directory() {
  if [[ "$(id -un)" != "$BUILD_USER" ]]; then
    chown -R "$BUILD_USER" "$STAGING_DIR"
  fi
}

freeze_release() {
  local release="$1"
  if [[ "$(id -u)" == "0" ]]; then
    chown -R "root:$DEPLOY_GROUP" "$release"
    chmod -R u=rwX,go=rX "$release"
  else
    chmod -R a-w "$release"
  fi
}

secure_release_link() {
  local link="$1"
  if [[ "$(id -u)" == "0" ]]; then
    chown -h "root:$DEPLOY_GROUP" "$link"
  fi
}

package_has_migration_script() {
  local package_file="$1"
  node - "$package_file" <<'NODE'
const fs = require("node:fs");
const packageFile = process.argv[2];
const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
process.exit(packageJson.scripts?.["db:migrate"] ? 0 : 1);
NODE
}

package_has_script() {
  local package_file="$1"
  local script_name="$2"
  node - "$package_file" "$script_name" <<'NODE'
const fs = require("node:fs");
const packageFile = process.argv[2];
const scriptName = process.argv[3];
const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
process.exit(packageJson.scripts?.[scriptName] ? 0 : 1);
NODE
}

detect_migration_mode() {
  local release="$1"
  if [[ -x "$release/deploy/hooks/migrate" ]]; then
    printf '%s\n' hook
  elif [[ -f "$release/apps/server/package.json" ]] && package_has_migration_script "$release/apps/server/package.json"; then
    printf '%s\n' package-script
  else
    printf '%s\n' none
  fi
}

restart_services() {
  "$SYSTEMCTL_BIN" restart baccarat-api baccarat-worker
}

readiness_once() {
  local release="$1"
  "$SYSTEMCTL_BIN" is-active --quiet baccarat-api
  "$SYSTEMCTL_BIN" is-active --quiet baccarat-worker

  if [[ -x "$release/deploy/hooks/readiness" ]]; then
    run_in_release "$release" "$release/deploy/hooks/readiness" "$HEALTH_URL"
  else
    "$CURL_BIN" --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null
  fi
}

wait_until_ready() {
  local release="$1"
  local attempt
  for ((attempt = 1; attempt <= READINESS_ATTEMPTS; attempt += 1)); do
    if readiness_once "$release"; then
      return 0
    fi
    log "readiness attempt $attempt/$READINESS_ATTEMPTS failed"
    if (( attempt < READINESS_ATTEMPTS )); then
      sleep "$READINESS_INTERVAL"
    fi
  done
  return 1
}

previous_release=""

if git -C "$SOURCE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  require_command git
  source_commit_sha="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
  source_branch="$(git -C "$SOURCE_DIR" symbolic-ref --quiet --short HEAD)" ||
    die "source HEAD must be attached to a branch"
  [[ "$source_commit_sha" == "$RELEASE_SHA" ]] ||
    die "release SHA $RELEASE_SHA does not match source HEAD $source_commit_sha"
  [[ -z "$(git -C "$SOURCE_DIR" status --porcelain=v1 --untracked-files=all)" ]] ||
    die "source worktree must be clean"

  export BUILD_COMMIT_SHA="$source_commit_sha"
  export BUILD_BRANCH="$source_branch"
  export BUILD_DIRTY=false

  if package_has_script "$SOURCE_DIR/package.json" "release:preflight"; then
    log "running authoritative release preflight in source checkout"
    (cd "$SOURCE_DIR" && run_as_release_user "$NPM_BIN" run release:preflight)
  fi
elif [[ "$DEPLOY_ROOT" == "/opt/baccarat" ]]; then
  die "production source must be a Git checkout so SHA and branch can be verified"
fi

if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  die "$CURRENT_LINK must be a symlink, not a file or directory"
fi
if [[ -e "$PREVIOUS_LINK" && ! -L "$PREVIOUS_LINK" ]]; then
  die "$PREVIOUS_LINK must be a symlink, not a file or directory"
fi
if [[ -L "$CURRENT_LINK" ]]; then
  previous_release="$(resolve_link "$CURRENT_LINK")"
  [[ -d "$previous_release" ]] || die "current symlink target is not a directory: $previous_release"
fi

if [[ "$previous_release" == "$RELEASE_DIR" ]]; then
  load_env_file "$ENV_FILE"
  PRODUCTION_ENV_LOADED=true
  wait_until_ready "$RELEASE_DIR" || die "release is active but not ready: $RELEASE_SHA"
  log "release $RELEASE_SHA is already active and ready"
  exit 0
fi

if [[ -d "$RELEASE_DIR" ]]; then
  [[ -f "$RELEASE_DIR/.release-sha" && -f "$RELEASE_DIR/.migration-mode" ]] ||
    die "existing release is missing immutable release markers: $RELEASE_DIR"
  [[ "$(<"$RELEASE_DIR/.release-sha")" == "$RELEASE_SHA" ]] || die "release marker mismatch: $RELEASE_DIR"
  [[ -f "$RELEASE_DIR/.migration-complete" ]] || die "existing release is incomplete: $RELEASE_DIR"
  migration_mode="$(<"$RELEASE_DIR/.migration-mode")"
  if [[ "$migration_mode" != "none" && -n "$previous_release" ]]; then
    [[ -f "$RELEASE_DIR/.rollback-compatible-from" ]] || die "release lacks rollback compatibility evidence"
    [[ "$(<"$RELEASE_DIR/.rollback-compatible-from")" == "$(basename "$previous_release")" ]] ||
      die "release was not verified against the active rollback target"
  fi
  freeze_release "$RELEASE_DIR"
  log "reusing prepared immutable release $RELEASE_DIR"
else
  [[ ! -e "$STAGING_DIR" ]] ||
    die "staging directory already exists; inspect it before manual cleanup: $STAGING_DIR"
  mkdir -m 0750 "$STAGING_DIR"

  log "copying source into staging release"
  (
    cd "$SOURCE_DIR"
    tar --exclude='.git' --exclude='node_modules' --exclude='*/node_modules' --exclude='*/dist' -cf - .
  ) | (
    cd "$STAGING_DIR"
    tar -xf -
  )
  own_staging_directory

  if [[ -x "$STAGING_DIR/deploy/hooks/preflight" ]]; then
    log "running release preflight hook"
    run_in_release "$STAGING_DIR" "$STAGING_DIR/deploy/hooks/preflight"
  fi

  log "installing locked dependencies"
  run_in_release "$STAGING_DIR" "$NPM_BIN" ci
  if [[ -x "$STAGING_DIR/deploy/hooks/build" ]]; then
    log "running release build hook"
    run_in_release "$STAGING_DIR" "$STAGING_DIR/deploy/hooks/build"
  else
    log "building all workspaces"
    run_in_release "$STAGING_DIR" "$NPM_BIN" run build
  fi

  migration_mode="$(detect_migration_mode "$STAGING_DIR")"
  # Keep production credentials out of npm lifecycle/build processes. They are
  # loaded only after the build, for migration and readiness hooks.
  load_env_file "$ENV_FILE"
  PRODUCTION_ENV_LOADED=true
  if [[ "$migration_mode" != "none" && -n "$previous_release" ]]; then
    compatibility_hook="$STAGING_DIR/deploy/hooks/verify-rollback-compatibility"
    [[ -x "$compatibility_hook" ]] ||
      die "migration detected; add executable deploy/hooks/verify-rollback-compatibility before deploying"
    log "verifying rollback compatibility with $(basename "$previous_release")"
    run_in_release "$STAGING_DIR" "$compatibility_hook" "$previous_release"
    printf '%s\n' "$(basename "$previous_release")" > "$STAGING_DIR/.rollback-compatible-from"
  elif [[ "$migration_mode" != "none" ]]; then
    log "WARNING: first deployment has no previous release to roll back to"
    printf '%s\n' none > "$STAGING_DIR/.rollback-compatible-from"
  fi

  printf '%s\n' "$migration_mode" > "$STAGING_DIR/.migration-started"
  case "$migration_mode" in
    hook)
      log "running migration hook"
      run_in_release "$STAGING_DIR" "$STAGING_DIR/deploy/hooks/migrate"
      ;;
    package-script)
      log "running detected server db:migrate package script"
      run_in_release "$STAGING_DIR" "$NPM_BIN" run db:migrate --workspace server
      ;;
    none)
      log "no migration hook or db:migrate package script detected; skipping migration"
      ;;
    *)
      die "unsupported migration mode: $migration_mode"
      ;;
  esac

  printf '%s\n' "$RELEASE_SHA" > "$STAGING_DIR/.release-sha"
  printf '%s\n' "$migration_mode" > "$STAGING_DIR/.migration-mode"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGING_DIR/.migration-complete"
  rm -f "$STAGING_DIR/.migration-started"
  if [[ "$(id -u)" == "0" ]]; then
    freeze_release "$STAGING_DIR"
    mv "$STAGING_DIR" "$RELEASE_DIR"
  else
    # The portable test path runs without root. Some platforms refuse to
    # rename a directory after its owner write bit is removed.
    mv "$STAGING_DIR" "$RELEASE_DIR"
    freeze_release "$RELEASE_DIR"
  fi
  log "prepared immutable release $RELEASE_DIR"
fi

if [[ "$PRODUCTION_ENV_LOADED" != true ]]; then
  load_env_file "$ENV_FILE"
  PRODUCTION_ENV_LOADED=true
fi

log "atomically activating release $RELEASE_SHA"
atomic_symlink "$RELEASE_DIR" "$CURRENT_LINK"
secure_release_link "$CURRENT_LINK"

activation_ok=true
if ! restart_services; then
  log "service restart failed"
  activation_ok=false
elif ! wait_until_ready "$RELEASE_DIR"; then
  log "release readiness failed"
  activation_ok=false
fi

if [[ "$activation_ok" != true ]]; then
  if [[ -n "$previous_release" ]]; then
    log "rolling back current symlink to $(basename "$previous_release")"
    atomic_symlink "$previous_release" "$CURRENT_LINK"
    secure_release_link "$CURRENT_LINK"
    if restart_services && wait_until_ready "$previous_release"; then
      log "rollback completed and previous release is ready"
      die "deployment failed; previous compatible release restored"
    fi
    die "deployment and automated rollback both failed; operator intervention required"
  fi

  rm -f "$CURRENT_LINK"
  "$SYSTEMCTL_BIN" stop baccarat-api baccarat-worker || true
  die "first deployment failed and no previous release was available"
fi

if [[ -n "$previous_release" ]]; then
  atomic_symlink "$previous_release" "$PREVIOUS_LINK"
  secure_release_link "$PREVIOUS_LINK"
fi
log "release $RELEASE_SHA is active and ready"
