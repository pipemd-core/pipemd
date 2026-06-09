#!/usr/bin/env bash
set -uo pipefail
# Go lint — go vet, compact summary-first format
source "$(dirname "$0")/../lib/limit.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINT_COMPACT="$SCRIPT_DIR/../lib/lint-compact.sh"
[ -f "$LINT_COMPACT" ] || LINT_COMPACT="$SCRIPT_DIR/../../Shared/lib/lint-compact.sh"
source "$LINT_COMPACT"

if ! command -v go &>/dev/null; then
  echo "go not found"
  exit 0
fi

compact_go_vet "$MAX_LINT"
