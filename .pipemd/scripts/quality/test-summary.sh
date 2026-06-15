#!/usr/bin/env bash
set -uo pipefail
# Test summary — failure details + pass/fail counts, cached for speed.
# Uses stale-while-revalidate: serves cached results (even stale), refreshes in background.
# The daemon has a 10s timeout; full test suites often exceed that.
source "$(dirname "$0")/../lib/limit.sh"

cache_dir=".pipemd/cache"
cache_file="$cache_dir/test-summary.txt"
cache_ttl=300
pid_file="$cache_dir/test-summary.pid"

mkdir -p "$cache_dir"

_file_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

is_fresh() {
  [ -f "$1" ] || return 1
  local age=$(( $(date +%s) - $(_file_mtime "$1") ))
  [ "$age" -lt "$cache_ttl" ]
}

# Extract failure details + summary from test output
extract_test_summary() {
  local max="${1:-15}"
  local failures summary
  failures=$(grep -iE 'FAIL|✗|●|AssertionError|Expected:|Received:|Error:.*assert|FAILED' | head -"$max")
  summary=$(grep -iE 'Tests?[[:space:]]+[0-9]|Test Files|[0-9]+ (passed|failed)' | tail -2)
  if [ -n "$failures" ]; then
    echo "$failures"
    [ -n "$summary" ] && echo "" && echo "$summary"
  else
    [ -n "$summary" ] && echo "$summary" || echo "All tests passed"
  fi
}

if is_fresh "$cache_file"; then
  cat "$cache_file"
  exit 0
fi

if [ -f "$cache_file" ]; then
  cat "$cache_file"
else
  echo "Test summary running — results will appear on next refresh"
fi

if [ -f "$pid_file" ]; then
  pid=$(cat "$pid_file")
  if kill -0 "$pid" 2>/dev/null; then
    exit 0
  fi
fi

(
  echo $$ > "$pid_file"
  result=""
  if compgen -G "jest.config.*" &>/dev/null || [ -f jest.config.js ] || [ -f jest.config.ts ]; then
    result=$(npx jest --no-coverage --silent 2>&1 | extract_test_summary "$MAX_TEST")
  elif compgen -G "vitest.config.*" &>/dev/null || [ -f vitest.config.ts ] || [ -f vitest.config.js ]; then
    result=$(npx vitest run --reporter=verbose 2>&1 | extract_test_summary "$MAX_TEST")
  elif [ -f package.json ]; then
    test_cmd=$(node -e "const p=require('./package.json');console.log(p.scripts&&p.scripts['test:unit']?'test:unit':p.scripts&&p.scripts['test']?'test':'')" 2>/dev/null)
    if [ -n "$test_cmd" ]; then
      pkg_mgr="npm"
      [ -f pnpm-lock.yaml ] && pkg_mgr="pnpm"
      [ -f yarn.lock ] && pkg_mgr="yarn"
      result=$($pkg_mgr run $test_cmd 2>&1 | extract_test_summary "$MAX_TEST")
    fi
  fi

  if [ -n "$result" ]; then
    echo "$result" > "${cache_file}.tmp"
    mv -f "${cache_file}.tmp" "$cache_file"
  fi
  rm -f "$pid_file"
) </dev/null >/dev/null 2>&1 &
disown
