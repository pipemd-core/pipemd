#!/usr/bin/env bash
set -uo pipefail
# Find TODO, FIXME, HACK in C/C++ source files
source "$(dirname "$0")/../lib/limit.sh"
out=$(grep -rn --include="*.c" --include="*.cpp" --include="*.cc" --include="*.cxx" --include="*.h" --include="*.hpp" --include="*.hxx" 'TODO\|FIXME\|HACK' . 2>/dev/null \
  | grep -v '/.git/' \
  | grep -v '/.pipemd/' \
  | grep -v '/build/' \
  | grep -v '/cmake-build-' \
  | grep -v '/_deps/' \
  | grep -v '/.cache/')
limit_output "$out" "$MAX_TODOS" "$(echo "$out" | head -3 && echo "... and $(($(echo "$out" | wc -l) - 3)) more items")"