#!/usr/bin/env bash
# Quality check for scenario 02: response cache middleware in Hono
# Runs INSIDE a git worktree of the hono repo
set -euo pipefail

SCORE=0

# Grade 0 check: does it compile?
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

# Grade 2 check: is the response-cache middleware created with correct pattern?
if [ -f "src/middleware/response-cache/index.ts" ]; then
  # Must export a function called 'responseCache'
  if grep -q 'export.*responseCache' src/middleware/response-cache/index.ts 2>/dev/null; then
    # Must call next() (middleware pattern)
    if grep -q 'next()' src/middleware/response-cache/index.ts 2>/dev/null; then
      # Must use cache (Map or similar)
      if grep -q 'Map\|cache' src/middleware/response-cache/index.ts 2>/dev/null; then
        SCORE=2
      fi
    fi
  fi
fi

echo "$SCORE"
