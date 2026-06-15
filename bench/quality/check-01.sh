#!/usr/bin/env bash
# Quality check for scenario 01: add AGENTS.md existence check to pmd doctor
# Runs INSIDE a git worktree of the pipemd repo
set -euo pipefail

SCORE=0

# Grade 0: tsc must pass
if ! npx tsc --noEmit >/dev/null 2>&1; then
  echo "0"
  exit 0
fi

# Grade 1: doctor.ts must be modified
modified=$(git status --porcelain -- src/commands/doctor.ts 2>/dev/null | wc -l)
if [ "$modified" -eq 0 ]; then
  echo "0"
  exit 0
fi
SCORE=1

# Grade 2: must check for AGENTS.md existence
if grep -qiE 'AGENTS\.md|agents\.md|context.*file.*exist|existsSync.*agents|fileExist.*AGENTS' src/commands/doctor.ts 2>/dev/null; then
  SCORE=2
fi

echo "$SCORE"
