#!/usr/bin/env bash
set -uo pipefail
# Lint errors — ruff or flake8
source "$(dirname "$0")/../lib/limit.sh"
if command -v ruff &>/dev/null; then
  out=$(ruff check . 2>&1)
  limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo "... and $(echo "$out" | wc -l) more lint issues")"
elif command -v flake8 &>/dev/null; then
  out=$(flake8 . --count --select=E9,F63,F7,F82 --show-source --statistics 2>&1)
  limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more flake8 errors')"
else
  echo "No linter configured"
fi