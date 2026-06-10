#!/usr/bin/env bash
set -uo pipefail
# Dead-code detection — unused exports, files, and dependencies.
# Uses stale-while-revalidate: serves cached results, refreshes in background.
# The daemon has a 10s timeout; knip can take 10-30s.
source "$(dirname "$0")/../lib/limit.sh" 2>/dev/null || source "$(cd "$(dirname "$0")/../../Shared" 2>/dev/null && pwd)/lib/limit.sh" 2>/dev/null || true

MULT_NUM="${MULT_NUM:-1}"
MULT_DEN="${MULT_DEN:-1}"
MAX_DEADCODE=$(( (${PMD_MAX_DEADCODE:-30} * MULT_NUM) / MULT_DEN ))
cache_dir=".pipemd/cache"
cache_file="$cache_dir/dead-code.txt"
cache_ttl=900
pid_file="$cache_dir/dead-code.pid"

mkdir -p "$cache_dir"

_file_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

is_fresh() {
  [ -f "$1" ] || return 1
  local age=$(( $(date +%s) - $(_file_mtime "$1") ))
  [ "$age" -lt "$cache_ttl" ]
}

if is_fresh "$cache_file"; then
  head -n "$MAX_DEADCODE" "$cache_file"
  exit 0
fi

if [ -f "$cache_file" ]; then
  head -n "$MAX_DEADCODE" "$cache_file"
else
  echo "Dead-code analysis running — results will appear on next refresh"
fi

if [ -f "$pid_file" ]; then
  pid=$(cat "$pid_file")
  if kill -0 "$pid" 2>/dev/null; then
    exit 0
  fi
fi

run_knip="$(dirname "$0")/run-knip.sh"
(
  "$run_knip" > "${cache_file}.tmp" 2>/dev/null
  mv -f "${cache_file}.tmp" "$cache_file"
  rm -f "$pid_file"
) </dev/null >/dev/null 2>&1 &
disown
