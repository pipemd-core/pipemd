#!/usr/bin/env bash
set -uo pipefail
# Find TODO, FIXME, HACK — generic (no file-type filter)
source "$(dirname "$0")/../lib/limit.sh"
out=$(grep -rn 'TODO\|FIXME\|HACK' . 2>/dev/null | grep -v '/.git/' | grep -v '/.pipemd/')
limit_output "$out" "$MAX_TODOS" "$(echo "$out" | head -3 && echo "... and $(($(echo "$out" | wc -l) - 3)) more items")"