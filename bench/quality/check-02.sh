#!/usr/bin/env bash
# Quality check for scenario 02: timing middleware in Hono
# Runs INSIDE a git worktree of the hono repo
set -euo pipefail

SCORE=0

# Grade 0 check: does it compile?
if ! npx tsc --noEmit 2>/dev/null; then
  echo "0"
  exit 0
fi

# Grade 1 check: did the agent modify any files?
modified=$(git diff --name-only 2>/dev/null | wc -l)
if [ "$modified" -eq 0 ]; then
  echo "0"
  exit 0
fi
SCORE=1

# Grade 2 check: is the middleware file created with correct pattern?
if [ -f "src/middleware/timing/index.ts" ]; then
  # Must export a function called 'timing'
  if grep -q 'export.*timing' src/middleware/timing/index.ts 2>/dev/null; then
    # Must call next() (middleware pattern)
    if grep -q 'next()' src/middleware/timing/index.ts 2>/dev/null; then
      # Must set a response header (timing data)
      if grep -q 'header\|Header' src/middleware/timing/index.ts 2>/dev/null; then
        SCORE=2
      fi
    fi
  fi
fi

echo "$SCORE"
