#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

for test_file in "$TEST_DIR"/*.test.sh; do
  printf '\n==> %s\n' "$(basename "$test_file")"
  bash "$test_file"
done

printf '\nAll deployment tests passed.\n'
