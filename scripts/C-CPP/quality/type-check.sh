#!/usr/bin/env bash
set -uo pipefail
# C/C++ type check — compiler warnings
source "$(dirname "$0")/../lib/limit.sh"

if [ -f CMakeLists.txt ] && [ -d build ]; then
  out=$(cmake --build build 2>&1 | grep -E 'warning:|error:' | head -30)
  if [ -z "$out" ]; then
    echo "No compiler warnings"
    exit 0
  fi
  limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -3 && echo '... more compiler warnings')"
  exit 0
fi

if [ -f Makefile ] || [ -f makefile ]; then
  out=$(make 2>&1 | grep -E 'warning:|error:' | head -30)
  if [ -z "$out" ]; then
    echo "No compiler warnings"
    exit 0
  fi
  limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -3 && echo '... more compiler warnings')"
  exit 0
fi

echo "No C/C++ type checker configured (build the project first)"