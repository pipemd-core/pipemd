#!/usr/bin/env bash
set -uo pipefail
# Go lint — go vet
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v go &>/dev/null; then
  echo "go not found"
  exit 0
fi

out=$(go vet ./... 2>&1 | head -30)
if [ -z "$out" ]; then
  echo "No go vet issues"
  exit 0
fi
limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more go vet warnings')"