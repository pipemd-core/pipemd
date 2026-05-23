#!/usr/bin/env bash
set -uo pipefail
# TypeScript type check — errors only
source "$(dirname "$0")/../lib/limit.sh"
out=$(npx tsc --noEmit 2>&1)
if [ -z "$out" ]; then
  echo "No type errors"
  exit 0
fi
limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -5 && echo "... and $(echo "$out" | grep -c 'error TS') total errors")"