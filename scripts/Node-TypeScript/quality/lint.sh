#!/usr/bin/env bash
set -uo pipefail
# Lint errors — compact format
source "$(dirname "$0")/../lib/limit.sh"
if compgen -G ".eslintrc.*" &>/dev/null || compgen -G "eslint.config.*" &>/dev/null || npx eslint --version &>/dev/null; then
  out=$(npx eslint . --format=compact 2>&1 | grep -E "^[^W]")
  limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo "... and $(echo "$out" | wc -l) more lint issues")"
else
  echo "No linter configured"
fi