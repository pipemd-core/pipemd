#!/usr/bin/env bash
set -uo pipefail
# Find TODO, FIXME, HACK — generic (no file-type filter)
source "$(dirname "$0")/../lib/limit.sh"
out=$(grep -rn 'TODO\|FIXME\|HACK' . 2>/dev/null \
  | grep -v '/.git/' \
  | grep -v '/.pipemd/' \
  | grep -v '/node_modules/' \
  | grep -v '/dist/' \
  | grep -v '/build/' \
  | grep -v '/.cache/' \
  | grep -v '/.angular/' \
  | grep -v '/.next/' \
  | grep -v '/coverage/' \
  | grep -v '/vendor/' \
  | grep -v '/target/' \
  | grep -v '/__pycache__/' \
  | grep -v '/venv/' \
  | grep -v '/.venv/')
[ -z "$out" ] && exit 0
limit_output "$out" "$MAX_TODOS" "$(echo "$out" | head -3 && echo "... and $(($(echo "$out" | wc -l) - 3)) more items")"