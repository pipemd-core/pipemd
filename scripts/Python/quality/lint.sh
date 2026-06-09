#!/usr/bin/env bash
set -uo pipefail
# Lint errors — compact summary-first format
source "$(dirname "$0")/../lib/limit.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINT_COMPACT="$SCRIPT_DIR/../lib/lint-compact.sh"
[ -f "$LINT_COMPACT" ] || LINT_COMPACT="$SCRIPT_DIR/../../Shared/lib/lint-compact.sh"
source "$LINT_COMPACT"

if command -v ruff &>/dev/null; then
  compact_ruff "$MAX_LINT"
elif command -v flake8 &>/dev/null; then
  compact_flake8 "$MAX_LINT"
else
  echo "No linter configured"
fi
