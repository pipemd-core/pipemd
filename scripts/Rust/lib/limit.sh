#!/usr/bin/env bash
set -uo pipefail
# limit.sh — Rust ecosystem overrides

TREE_EXCLUDES="${PMD_TREE_EXCLUDES:-target|.git|.pipemd|node_modules|cargo-registry}"
TREE_FIND_EXCLUDES=" \
  -not -path '*/target/*' \
  -not -path '*/.git/*' \
  -not -path '*/.pipemd/*' \
  -not -path '*/node_modules/*' \
  -not -name 'target' \
  -not -name '.git' \
  -not -name '.pipemd'"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../Shared/lib/limit-core.sh"
