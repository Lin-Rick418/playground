#!/usr/bin/env bash

# Shared by deployment scripts. Callers must enable strict mode themselves.

log() {
  printf '[baccarat-ops] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

assert_private_file() {
  local file="$1"
  local mode
  if mode="$(stat -c '%a' "$file" 2>/dev/null)"; then
    :
  elif mode="$(stat -f '%Lp' "$file" 2>/dev/null)"; then
    :
  else
    die "cannot inspect permissions for $file"
  fi

  # Production env files are root-owned and may be group-readable by the
  # dedicated runtime config group. They must never be group-writable or
  # accessible by other users.
  if (( (8#$mode & 027) != 0 )); then
    die "environment file must not be group-writable or world-accessible: $file (mode $mode)"
  fi
}

load_env_file() {
  local env_file="$1"
  local line key value

  [[ -f "$env_file" ]] || die "environment file not found: $env_file"
  assert_private_file "$env_file"

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || die "invalid environment line in $env_file"

    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid environment key in $env_file: $key"

    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "$key=$value"
  done < "$env_file"
}

atomic_symlink() {
  local target="$1"
  local link_path="$2"
  local temporary_link="${link_path}.tmp.$$.$RANDOM"

  ln -s "$target" "$temporary_link"
  if ! node - "$temporary_link" "$link_path" <<'NODE'
const fs = require("node:fs");
const [, , source, destination] = process.argv;
fs.renameSync(source, destination);
NODE
  then
    rm -f "$temporary_link"
    return 1
  fi
}

resolve_link() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
process.stdout.write(fs.realpathSync(path));
NODE
}

checksum_create() {
  local file="$1"
  local output="$2"
  local directory basename
  directory="$(dirname "$file")"
  basename="$(basename "$file")"

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$directory" && sha256sum "$basename") > "$output"
  else
    require_command shasum
    (cd "$directory" && shasum -a 256 "$basename") > "$output"
  fi
}

checksum_verify() {
  local checksum_file="$1"
  local target_file expected actual checksum_output
  target_file="${checksum_file%.sha256}"
  [[ -f "$target_file" ]] || die "checksum target not found: $target_file"
  read -r expected _ < "$checksum_file"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "invalid SHA-256 checksum file: $checksum_file"

  if command -v sha256sum >/dev/null 2>&1; then
    checksum_output="$(sha256sum "$target_file")"
  else
    require_command shasum
    checksum_output="$(shasum -a 256 "$target_file")"
  fi
  actual="${checksum_output%%[[:space:]]*}"
  [[ "$actual" == "$expected" ]] || die "backup checksum mismatch: $target_file"
}
