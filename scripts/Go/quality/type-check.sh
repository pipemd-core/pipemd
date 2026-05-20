#!/usr/bin/env bash
set -uo pipefail
# Go type check — go build check
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v go &>/dev/null; then
  echo "go not found"
  exit 0
fi

out=$(go build ./... 2>&1 | head -20)
if [ -z "$out" ]; then
  echo "No build errors"
  exit 0
fi
limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -3 && echo '... more build errors')"