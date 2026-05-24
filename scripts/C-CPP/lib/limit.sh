#!/usr/bin/env bash
set -uo pipefail
# limit.sh — C/C++ ecosystem overrides

TREE_EXCLUDES="${PMD_TREE_EXCLUDES:-node_modules|.git|.pipemd|dist|coverage|build|cmake-build-*|_deps|.cache|compile_commands.json}"
TREE_FIND_EXCLUDES=" \
  -not -path '*/build/*' \
  -not -path '*/cmake-build-*/*' \
  -not -path '*/_deps/*' \
  -not -path '*/.git/*' \
  -not -path '*/.pipemd/*' \
  -not -path '*/.cache/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -path '*/coverage/*' \
  -not -name 'build' \
  -not -name '.git' \
  -not -name '.pipemd' \
  -not -name 'compile_commands.json' \
  -not -name 'dist' \
  -not -name 'coverage'"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../Shared/lib/limit-core.sh"
