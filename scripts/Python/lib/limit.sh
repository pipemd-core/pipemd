#!/usr/bin/env bash
set -uo pipefail
# limit.sh — Python ecosystem overrides

TREE_EXCLUDES="${PMD_TREE_EXCLUDES:-__pycache__|.git|.pipemd|venv|.venv|*.egg-info|node_modules|dist|build}"
TREE_FIND_EXCLUDES=" \
  -not -path '*/__pycache__/*' \
  -not -path '*/.git/*' \
  -not -path '*/.pipemd/*' \
  -not -path '*/venv/*' \
  -not -path '*/.venv/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -name '__pycache__' \
  -not -name '.git' \
  -not -name '.pipemd' \
  -not -name 'dist' \
  -not -name 'build'"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIMIT_CORE="$SCRIPT_DIR/limit-core.sh"
[ -f "$LIMIT_CORE" ] || LIMIT_CORE="$SCRIPT_DIR/../../Shared/lib/limit-core.sh"
source "$LIMIT_CORE"
