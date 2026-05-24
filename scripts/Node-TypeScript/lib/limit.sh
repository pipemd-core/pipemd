#!/usr/bin/env bash
set -uo pipefail
# limit.sh — Node/TypeScript ecosystem overrides

TREE_EXCLUDES="${PMD_TREE_EXCLUDES:-node_modules|.git|.pipemd|dist|coverage|.next|.turbo|build|out|__pycache__|venv|.venv|*.egg-info}"
TREE_FIND_EXCLUDES=" \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/.pipemd/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/.next/*' \
  -not -path '*/.turbo/*' \
  -not -path '*/coverage/*' \
  -not -path '*/out/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/venv/*' \
  -not -path '*/.venv/*' \
  -not -name 'node_modules' \
  -not -name '.git' \
  -not -name '.pipemd' \
  -not -name '.turbo' \
  -not -name 'out' \
  -not -name '__pycache__' \
  -not -name 'venv' \
  -not -name '.venv'"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../Shared/lib/limit-core.sh"
