#!/usr/bin/env bash
set -uo pipefail
# Python type check (mypy) — errors only
source "$(dirname "$0")/../lib/limit.sh"
out=$(python -m mypy . 2>&1)
if [ -z "$out" ]; then
  echo "No type errors"
  exit 0
fi
limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -5 && echo '... more mypy errors')"