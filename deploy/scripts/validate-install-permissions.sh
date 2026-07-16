#!/usr/bin/env bash

set -euo pipefail

CURRENT_PATH="${BACCARAT_CURRENT_PATH:-/opt/baccarat/current}"
RELEASE_ROOT="${BACCARAT_RELEASE_ROOT:-/opt/baccarat/releases}"
ENV_FILE="${BACCARAT_ENV_FILE:-/etc/baccarat/baccarat.env}"
SYSTEMD_DIR="${BACCARAT_SYSTEMD_DIR:-/etc/systemd/system}"
DEPLOY_GROUP="${BACCARAT_DEPLOY_GROUP:-deployer}"
CONFIG_GROUP="${BACCARAT_CONFIG_GROUP:-baccarat}"
API_USER="${BACCARAT_API_USER:-baccarat-api}"
WORKER_USER="${BACCARAT_WORKER_USER:-baccarat-worker}"

failures=0

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    printf 'Run this validator as root so runtime-user write checks are authoritative.\n' >&2
    exit 2
  fi
}

require_path() {
  local path="$1"

  if [[ ! -e "$path" && ! -L "$path" ]]; then
    fail "$path exists"
    return 1
  fi

  pass "$path exists"
}

check_owner_group() {
  local path="$1"
  local expected_owner="$2"
  local expected_group="$3"
  local actual

  actual="$(stat -c '%U:%G' "$path")"
  if [[ "$actual" == "$expected_owner:$expected_group" ]]; then
    pass "$path is owned by $expected_owner:$expected_group"
  else
    fail "$path ownership is $actual (expected $expected_owner:$expected_group)"
  fi
}

check_mode() {
  local path="$1"
  local expected="$2"
  local actual

  actual="$(stat -c '%a' "$path")"
  if [[ "$actual" == "$expected" ]]; then
    pass "$path mode is $actual"
  else
    fail "$path mode is $actual (expected $expected)"
  fi
}

check_not_writable_by_runtime() {
  local path="$1"
  local user

  for user in "$API_USER" "$WORKER_USER"; do
    if runuser -u "$user" -- test -w "$path"; then
      fail "$path is writable by $user"
    else
      pass "$path is not writable by $user"
    fi
  done
}

check_readable_by_runtime() {
  local path="$1"
  local user

  for user in "$API_USER" "$WORKER_USER"; do
    if runuser -u "$user" -- test -r "$path"; then
      pass "$path is readable by $user"
    else
      fail "$path is not readable by $user"
    fi
  done
}

check_no_mutable_release_entries() {
  local release="$1"
  local mutable_entry
  local non_root_entry
  local symlink
  local symlink_target

  mutable_entry="$(find -L "$release" -xdev \( -type f -o -type d \) -perm /022 -print -quit)"
  if [[ -n "$mutable_entry" ]]; then
    fail "release contains a group/other-writable entry: $mutable_entry"
  else
    pass "release contains no group/other-writable files or directories"
  fi

  non_root_entry="$(find -L "$release" -xdev ! -user root -print -quit)"
  if [[ -n "$non_root_entry" ]]; then
    fail "active release contains a non-root-owned entry: $non_root_entry"
  else
    pass "every active release entry is root-owned"
  fi

  while IFS= read -r -d '' symlink; do
    if ! symlink_target="$(readlink -f "$symlink")"; then
      fail "active release contains a dangling symlink: $symlink"
      continue
    fi

    case "$symlink_target/" in
      "$release"/*)
        ;;
      *)
        fail "active release symlink escapes the release root: $symlink -> $symlink_target"
        ;;
    esac
  done < <(find "$release" -xdev -type l -print0)
}

check_env_mode() {
  local mode

  mode="$(stat -c '%a' "$ENV_FILE")"
  if [[ "$mode" == "640" || "$mode" == "440" ]]; then
    pass "$ENV_FILE mode is $mode"
  else
    fail "$ENV_FILE mode is $mode (expected 0640 or 0440)"
  fi
}

check_unit() {
  local unit="$1"
  local path="$SYSTEMD_DIR/$unit"
  local mode

  require_path "$path" || return
  check_owner_group "$path" root root
  mode="$(stat -c '%a' "$path")"
  if (( (8#$mode & 8#022) == 0 )); then
    pass "$path is not group/other writable"
  else
    fail "$path mode $mode permits group/other writes"
  fi
}

require_root

for command in stat find readlink runuser dirname; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command" >&2
    exit 2
  fi
done

getent group "$DEPLOY_GROUP" >/dev/null || fail "deployment group $DEPLOY_GROUP exists"
getent group "$CONFIG_GROUP" >/dev/null || fail "configuration group $CONFIG_GROUP exists"
id "$API_USER" >/dev/null 2>&1 || fail "runtime user $API_USER exists"
id "$WORKER_USER" >/dev/null 2>&1 || fail "runtime user $WORKER_USER exists"

if (( failures > 0 )); then
  printf '\nIdentity validation failed with %d finding(s).\n' "$failures" >&2
  exit 1
fi

if require_path "$CURRENT_PATH" && require_path "$RELEASE_ROOT"; then
  current_parent="$(dirname "$CURRENT_PATH")"
  resolved_current="$(readlink -f "$CURRENT_PATH")"
  resolved_releases="$(readlink -f "$RELEASE_ROOT")"

  if [[ -L "$CURRENT_PATH" ]]; then
    pass "$CURRENT_PATH is a symlink"
  else
    fail "$CURRENT_PATH is not a symlink"
  fi

  check_owner_group "$current_parent" root "$DEPLOY_GROUP"
  check_mode "$current_parent" 755
  check_owner_group "$RELEASE_ROOT" root "$DEPLOY_GROUP"
  check_mode "$RELEASE_ROOT" 755
  check_owner_group "$CURRENT_PATH" root "$DEPLOY_GROUP"
  check_not_writable_by_runtime "$current_parent"
  check_not_writable_by_runtime "$RELEASE_ROOT"

  case "$resolved_current/" in
    "$resolved_releases"/*)
      pass "$CURRENT_PATH resolves inside $RELEASE_ROOT"
      ;;
    *)
      fail "$CURRENT_PATH resolves outside $RELEASE_ROOT: $resolved_current"
      ;;
  esac

  check_owner_group "$resolved_current" root "$DEPLOY_GROUP"
  check_no_mutable_release_entries "$resolved_current"
  check_readable_by_runtime "$resolved_current/apps/server/dist/index.js"
  check_readable_by_runtime "$resolved_current/apps/server/dist/worker.js"
  check_not_writable_by_runtime "$resolved_current"
  check_not_writable_by_runtime "$CURRENT_PATH"
fi

if require_path "$ENV_FILE"; then
  env_directory="$(dirname "$ENV_FILE")"
  check_owner_group "$env_directory" root "$CONFIG_GROUP"
  check_mode "$env_directory" 750
  check_not_writable_by_runtime "$env_directory"
  check_owner_group "$ENV_FILE" root "$CONFIG_GROUP"
  check_env_mode
  check_readable_by_runtime "$ENV_FILE"
  check_not_writable_by_runtime "$ENV_FILE"
fi

check_unit baccarat-api.service
check_unit baccarat-worker.service
check_not_writable_by_runtime "$SYSTEMD_DIR"

if (( failures > 0 )); then
  printf '\nPermission validation failed with %d finding(s).\n' "$failures" >&2
  exit 1
fi

printf '\nPermission validation passed.\n'
