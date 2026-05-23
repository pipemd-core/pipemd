#!/usr/bin/env bash
set -uo pipefail
# limit.sh — Generic ecosystem (same as Shared defaults)

TREE_EXCLUDES="${PMD_TREE_EXCLUDES:-.git|.pipemd}"
TREE_FIND_EXCLUDES=" \
  -not -path '*/.git/*' \
  -not -path '*/.pipemd/*' \
  -not -name '.git' \
  -not -name '.pipemd'"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../Shared/lib/limit-core.sh"
