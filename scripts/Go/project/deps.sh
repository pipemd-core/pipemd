#!/usr/bin/env bash
set -uo pipefail
# Go dependencies — parse go.mod require directives
source "$(dirname "$0")/../lib/limit.sh"

if [ ! -f go.mod ]; then
  echo "No go.mod found"
  exit 0
fi

# Prefer go list -m all if go is available
if command -v go &>/dev/null; then
  out=$(go list -m all 2>/dev/null | tail -n +2 | head -"$MAX_DEPS")
  if [ -n "$out" ]; then
    echo "Dependencies:"
    echo "$out"
    exit 0
  fi
fi

# Fallback: parse go.mod with awk
out=$(awk '
/^require[[:space:]]*\(/ { in_req=1; next }
in_req && /^\)[[:space:]]*$/ { in_req=0; next }
in_req && /^[[:space:]]+[^/]/ { print $1, $2 }
/^require[[:space:]]+/ && !/\(/ { print $2, $3 }
' go.mod 2>/dev/null | head -"$MAX_DEPS")

if [ -z "$out" ]; then
  echo "No dependencies found in go.mod"
  exit 0
fi

echo "Dependencies:"
echo "$out"