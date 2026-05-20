#!/usr/bin/env bash
set -uo pipefail
# Find TODO, FIXME, HACK in Go source files
source "$(dirname "$0")/../lib/limit.sh"
out=$(grep -rn --include="*.go" 'TODO\|FIXME\|HACK\|XXX' . 2>/dev/null | grep -v '/.git/' | grep -v '/.pipemd/' | grep -v '/vendor/')
limit_output "$out" "$MAX_TODOS" "$(echo "$out" | head -3 && echo "... and $(($(echo "$out" | wc -l) - 3)) more items")"