#!/usr/bin/env bash
# Quality check for scenario 01: pmd status --format json
# Runs INSIDE a git worktree of the pipemd repo
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

# Grade 2 check: is --format json implemented in the status command?
# Must have the --format option AND produce JSON output with required fields
if grep -q "\.option.*--format" src/commands/status.ts 2>/dev/null; then
  # Check for JSON.stringify or JSON output
  if grep -q 'JSON.stringify\|"running"\|"format".*"json"' src/commands/status.ts 2>/dev/null; then
    # Check for at least 3 of the required fields
    found_fields=0
    for field in "running" "pid" "uptime" "version" "pipes" "lastRender" "injectStats"; do
      if grep -q "$field" src/commands/status.ts 2>/dev/null; then
        found_fields=$((found_fields + 1))
      fi
    done
    if [ "$found_fields" -ge 3 ]; then
      SCORE=2
    fi
  fi
fi

echo "$SCORE"
