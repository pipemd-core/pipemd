#!/usr/bin/env bash
set -uo pipefail
# Go dependencies + toolchain + verify commands.
# The `go <ver>` directive decides stdlib API availability (e.g. slices.SortFunc),
# so it is surfaced first — it is the single most load-bearing fact for Go tasks.
source "$(dirname "$0")/../lib/limit.sh"

if [ ! -f go.mod ]; then
  echo "No go.mod found"
  exit 0
fi

go_ver=$(awk '/^go[[:space:]]+/{print "go "$2; exit}' go.mod 2>/dev/null)
[ -n "$go_ver" ] && echo "Toolchain: $go_ver"

deps=""
if command -v go &>/dev/null; then
  deps=$(go list -m all 2>/dev/null | tail -n +2 | head -"$MAX_DEPS")
fi
if [ -z "$deps" ]; then
  deps=$(awk '
    /^require[[:space:]]*\(/ { in_req=1; next }
    in_req && /^\)[[:space:]]*$/ { in_req=0; next }
    in_req && /^[[:space:]]+[^/]/ { print $1, $2 }
    /^require[[:space:]]+/ && !/\(/ { print $2, $3 }
  ' go.mod 2>/dev/null | head -"$MAX_DEPS")
fi

if [ -n "$deps" ]; then
  echo "Dependencies:"
  echo "$deps"
else
  echo "Dependencies: none (stdlib-only module)"
fi

echo "Verify: go test ./..."
echo "Lint: go vet ./..."
