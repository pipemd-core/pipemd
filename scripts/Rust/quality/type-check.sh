#!/usr/bin/env bash
set -uo pipefail
# Rust type check — cargo check
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v cargo &>/dev/null; then
  echo "cargo not found"
  exit 0
fi

out=$(cargo check 2>&1 | grep -E '^error' | head -20)
if [ -z "$out" ]; then
  echo "No type errors"
  exit 0
fi
limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -5 && echo '... more type errors')"