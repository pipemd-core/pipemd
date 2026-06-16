#!/usr/bin/env bash
# Quality check for scenario 03: centralized error handler in Hono
# Runs INSIDE a git worktree of the hono repo
set -euo pipefail

SCORE=0

# Grade 0 check: does it compile and lint?
if ! npx tsc --noEmit >/dev/null 2>&1; then
  echo "0"
  exit 0
fi

# Grade 1 check: did the agent modify any files?
modified=$(git status --porcelain -- src/ 2>/dev/null | wc -l)
if [ "$modified" -eq 0 ]; then
  echo "0"
  exit 0
fi
SCORE=1

# Grade 2 check: modified hono-base.ts with improved error handler (not comments)
CODE=$(grep -v '^\s*//' src/hono-base.ts 2>/dev/null | grep -v '^\s*\*')
if echo "$CODE" | grep -q 'application/json\|"error".*true\|errorResponse' 2>/dev/null; then
  # Must still handle HTTPException (existing behavior preserved)
  if echo "$CODE" | grep -q 'HTTPException\|getResponse' 2>/dev/null; then
    SCORE=2
  fi
fi

echo "$SCORE"
