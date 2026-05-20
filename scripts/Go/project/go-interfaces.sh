#!/usr/bin/env bash
set -uo pipefail
# Go interfaces — extract interface definitions from source
source "$(dirname "$0")/../lib/limit.sh"

out=$(grep -rn --include="*.go" -E 'type\s+\w+\s+interface\s*\{' . 2>/dev/null \
  | grep -v '/vendor/' | grep -v '/.git/' \
  | sed -E 's/(.*):type\s+(\w+)\s+interface.*/\2 (\1)/' \
  | sort -u \
  | head -"$MAX_GO_INTERFACES")

if [ -z "$out" ]; then
  echo "No Go interfaces found"
  exit 0
fi

echo "Interfaces:"
echo "$out"