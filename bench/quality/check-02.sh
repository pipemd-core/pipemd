#!/usr/bin/env bash
# Quality gate — s2 (bt-lua): parallel-node runtime crash fix.
# Runs INSIDE the per-run worktree. Executes a bench-owned lua grader that
# builds a two-child Parallel tree (waitForAll=true) and asserts it finishes.
#
# Score: 0 = parallel.lua not touched; 1 = touched but grader fails; 2 = grader PASS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BENCH_TESTS="$SCRIPT_DIR/../tests"
GRADER="$BENCH_TESTS/parallel_bug_test.lua"

score=0

# Grade 1: the agent must have actually changed the suspected node.
if git status --porcelain -- lib/node_types/parallel.lua 2>/dev/null | grep -q .; then
  score=1
fi

# Grade 2: the grader passes (regardless of which file was edited).
if command -v lua >/dev/null 2>&1 && lua "$GRADER" 2>/dev/null | grep -q "PASS"; then
  score=2
fi

echo "$score"
