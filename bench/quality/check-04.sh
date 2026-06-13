#!/usr/bin/env bash
# Quality check for scenario 04: fix parallel node bug in behaviourtreelua2e
# Runs INSIDE a git worktree of the bt-lua repo
set -euo pipefail

SCORE=0

# Grade 1: was parallel.lua modified?
modified=$(git status --porcelain -- lib/node_types/parallel.lua 2>/dev/null | wc -l)
if [ "$modified" -eq 0 ]; then
  echo "0"
  exit 0
fi
SCORE=1

# Grade 2: does the fix actually work? Run the reproduction test
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_SCRIPT="$SCRIPT_DIR/../tests/parallel_bug_test.lua"

if [ -f "$TEST_SCRIPT" ] && lua "$TEST_SCRIPT" 2>/dev/null | grep -q "PASS"; then
  SCORE=2
fi

echo "$SCORE"
