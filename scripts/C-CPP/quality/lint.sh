#!/usr/bin/env bash
set -uo pipefail
# C/C++ lint — clang-tidy or cppcheck
source "$(dirname "$0")/../lib/limit.sh"

if command -v clang-tidy &>/dev/null; then
  out=$(clang-tidy --checks='-*,bugprone-*,modernize-*,readability-*' -p build . 2>&1 | head -50)
  limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more clang-tidy warnings')"
elif command -v cppcheck &>/dev/null; then
  out=$(cppcheck --enable=all --suppress=missingInclude . 2>&1 | head -50)
  limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more cppcheck warnings')"
else
  echo "No C/C++ linter found (install clang-tidy or cppcheck)"
fi