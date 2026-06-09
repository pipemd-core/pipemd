#!/usr/bin/env bash
set -uo pipefail
# C/C++ lint — clang-tidy or cppcheck, compact summary-first format
source "$(dirname "$0")/../lib/limit.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINT_COMPACT="$SCRIPT_DIR/../lib/lint-compact.sh"
[ -f "$LINT_COMPACT" ] || LINT_COMPACT="$SCRIPT_DIR/../../Shared/lib/lint-compact.sh"
source "$LINT_COMPACT"

if command -v clang-tidy &>/dev/null; then
  compact_clang_tidy "$MAX_LINT"
elif command -v cppcheck &>/dev/null; then
  compact_cppcheck "$MAX_LINT"
else
  echo "No C/C++ linter found (install clang-tidy or cppcheck)"
fi
