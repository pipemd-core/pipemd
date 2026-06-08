#!/usr/bin/env bash
set -uo pipefail
# Find TODO, FIXME, HACK — Python files
source "$(dirname "$0")/../lib/limit.sh"
out=$(grep -rn 'TODO\|FIXME\|HACK' --include="*.py" . 2>/dev/null \
  | grep -v '/__pycache__/' \
  | grep -v '/.pipemd/' \
  | grep -v '/venv/' \
  | grep -v '/.venv/' \
  | grep -v '/.git/' \
  | grep -v '/.tox/' \
  | grep -v '/.mypy_cache/' \
  | grep -v '/.pytest_cache/' \
  | grep -v '/site-packages/')
limit_output "$out" "$MAX_TODOS" "$(echo "$out" | head -3 && echo "... and $(($(echo "$out" | wc -l) - 3)) more items")"