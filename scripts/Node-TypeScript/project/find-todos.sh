#!/usr/bin/env bash
set -uo pipefail
# Find TODO, FIXME, HACK — TypeScript/JavaScript files
source "$(dirname "$0")/../lib/limit.sh"
out=$(grep -rn 'TODO\|FIXME\|HACK' --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" . 2>/dev/null \
  | grep -v '/node_modules/' \
  | grep -v '/.git/' \
  | grep -v '/.pipemd/' \
  | grep -v '/dist/' \
  | grep -v '/build/' \
  | grep -v '/.cache/' \
  | grep -v '/.angular/' \
  | grep -v '/.next/' \
  | grep -v '/coverage/')
limit_output "$out" "$MAX_TODOS" "$(echo "$out" | head -3 && echo "... and $(($(echo "$out" | wc -l) - 3)) more items")"