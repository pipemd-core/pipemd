#!/usr/bin/env bash
set -uo pipefail
# Lint errors — compact summary-first format
source "$(dirname "$0")/../lib/limit.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINT_COMPACT="$SCRIPT_DIR/../lib/lint-compact.sh"
[ -f "$LINT_COMPACT" ] || LINT_COMPACT="$SCRIPT_DIR/../../Shared/lib/lint-compact.sh"
source "$LINT_COMPACT"

if compgen -G ".eslintrc.*" &>/dev/null || compgen -G "eslint.config.*" &>/dev/null || npx eslint --version &>/dev/null; then
  compact_eslint "$MAX_LINT"
else
  echo "No linter configured"
fi
