#!/usr/bin/env bash
set -uo pipefail
# C/C++ test summary — ctest or make test
source "$(dirname "$0")/../lib/limit.sh"

if [ -f CMakeLists.txt ] && [ -d build ]; then
  out=$(ctest --test-dir build --output-on-failure 2>&1 | tail -10)
  if [ -n "$out" ]; then
    limit_output "$out" "$MAX_TEST" "$(echo "$out" | head -3 && echo '... more test results')"
    exit 0
  fi
fi

if [ -f Makefile ] || [ -f makefile ]; then
  out=$(make test 2>&1 | tail -10)
  if [ -n "$out" ]; then
    limit_output "$out" "$MAX_TEST" "$(echo "$out" | head -3 && echo '... more test results')"
    exit 0
  fi
fi

echo "No C/C++ test runner configured"