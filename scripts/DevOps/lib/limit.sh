#!/usr/bin/env bash
set -uo pipefail
# limit.sh — DevOps ecosystem overrides

TREE_EXCLUDES="${PMD_TREE_EXCLUDES:-.git|.pipemd|.terraform|node_modules|__pycache__|dist|build|coverage|target|vendor|bin}"
TREE_FIND_EXCLUDES=" \
  -not -path '*/.git/*' \
  -not -path '*/.pipemd/*' \
  -not -path '*/.terraform/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/coverage/*' \
  -not -path '*/target/*' \
  -not -path '*/vendor/*' \
  -not -name '.git' \
  -not -name '.pipemd' \
  -not -name '.terraform' \
  -not -name 'coverage' \
  -not -name 'target' \
  -not -name 'vendor' \
  -not -name 'bin'"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../Shared/lib/limit-core.sh"
