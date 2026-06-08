#!/usr/bin/env bash
set -uo pipefail
# Test summary — pass/fail counts, cached for speed.
# The daemon has a 10s timeout; full test suites often exceed that.
# Strategy: read a cached result if fresh (<5 min), else run a quick
# summary and cache it for next time.
source "$(dirname "$0")/../lib/limit.sh"

cache_dir=".pipemd/cache"
cache_file="$cache_dir/test-summary.txt"
cache_ttl=300

mkdir -p "$cache_dir"

if [ -f "$cache_file" ]; then
  cache_age=$(( $(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || echo 0) ))
  if [ "$cache_age" -lt "$cache_ttl" ]; then
    cat "$cache_file"
    exit 0
  fi
fi

result=""
if compgen -G "jest.config.*" &>/dev/null || [ -f jest.config.js ] || [ -f jest.config.ts ]; then
  result=$(npx jest --no-coverage --silent 2>&1 | tail -5)
elif compgen -G "vitest.config.*" &>/dev/null || [ -f vitest.config.ts ] || [ -f vitest.config.js ]; then
  result=$(npx vitest run --reporter=verbose 2>&1 | tail -5)
elif [ -f package.json ]; then
  test_cmd=$(node -e "const p=require('./package.json');console.log(p.scripts&&p.scripts['test:unit']?'test:unit':p.scripts&&p.scripts['test']?'test':'')" 2>/dev/null)
  if [ -n "$test_cmd" ]; then
    pkg_mgr="npm"
    [ -f pnpm-lock.yaml ] && pkg_mgr="pnpm"
    [ -f yarn.lock ] && pkg_mgr="yarn"
    result=$($pkg_mgr run $test_cmd 2>&1 | tail -"$MAX_TEST")
  fi
fi

if [ -n "$result" ]; then
  echo "$result" | tee "$cache_file"
else
  echo "No test runner configured for this ecosystem"
fi
