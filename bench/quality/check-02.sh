#!/usr/bin/env bash
# Quality check for scenario 02: response cache middleware in Hono
# Runs INSIDE a git worktree of the hono repo
set -euo pipefail

SCORE=0

# Grade 0 check: does it compile and lint?
if ! npx tsc --noEmit >/dev/null 2>&1; then
  echo "0"
  exit 0
fi
if ! npx eslint src/middleware/response-cache/index.ts >/dev/null 2>&1; then
  if [ -f "src/middleware/response-cache/index.ts" ]; then
    echo "0"
    exit 0
  fi
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
  CODE=$(grep -v '^\s*//' src/middleware/response-cache/index.ts 2>/dev/null | grep -v '^\s*\*')
  # Must export a function called 'responseCache'
  if echo "$CODE" | grep -q 'export.*responseCache' 2>/dev/null; then
    # Must call next() (middleware pattern)
    if echo "$CODE" | grep -q 'next()' 2>/dev/null; then
      # Must use cache (Map or similar)
      if echo "$CODE" | grep -q 'Map\|cache' 2>/dev/null; then
        SCORE=2
      fi
    fi
  fi
fi

echo "$SCORE"
