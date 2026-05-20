#!/usr/bin/env bash
set -uo pipefail
# Test summary — pass/fail counts only
source "$(dirname "$0")/../lib/limit.sh"

if compgen -G "jest.config.*" &>/dev/null || [ -f jest.config.js ] || [ -f jest.config.ts ]; then
  out=$(npx jest --no-coverage --silent 2>&1 | tail -5)
  if [ -z "$out" ]; then
    echo "jest ran but produced no output"
  else
    echo "$out"
  fi
  exit 0
elif compgen -G "vitest.config.*" &>/dev/null || [ -f vitest.config.ts ] || [ -f vitest.config.js ]; then
  out=$(npx vitest run --reporter=verbose 2>&1 | tail -5)
  if [ -z "$out" ]; then
    echo "vitest ran but produced no output"
  else
    echo "$out"
  fi
  exit 0
fi

# Fallback: detect test script in package.json
if [ -f package.json ]; then
  test_cmd=$(node -e "const p=require('./package.json');console.log(p.scripts&&p.scripts['test:unit']?'test:unit':p.scripts&&p.scripts['test']?'test':'')" 2>/dev/null)
  if [ -n "$test_cmd" ]; then
    pkg_mgr="npm"
    [ -f pnpm-lock.yaml ] && pkg_mgr="pnpm"
    [ -f yarn.lock ] && pkg_mgr="yarn"
    out=$($pkg_mgr run $test_cmd 2>&1 | tail -"$MAX_TEST")
    if [ -n "$out" ]; then
      echo "$out"
      exit 0
    fi
  fi
fi

echo "No test runner configured for this ecosystem"