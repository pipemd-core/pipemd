#!/usr/bin/env bash
# Quality check for scenario 01: improve pmd doctor
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

# Grade 2: at least 2 of the 3 requested features must be present
features=0

# Feature 1: script execution with timeout
# Base doctor.ts uses execSync (for mkfifo) but never execFileSync/spawnSync or timeouts.
# Require evidence of genuinely running scripts with a timeout.
if grep -qE 'execFileSync|spawnSync' src/commands/doctor.ts 2>/dev/null; then
  if grep -qiE 'timeout.*[23]000|[23]000.*timeout|3.?-?second' src/commands/doctor.ts 2>/dev/null; then
    features=$((features + 1))
  fi
fi

# Feature 2: block rendering check
if grep -qiE 'block.*(render|resolv|exec)|render.*block|pmd:.*tag' src/commands/doctor.ts 2>/dev/null; then
  features=$((features + 1))
fi

# Feature 3: --json flag
if grep -qE '\-\-json|format.*json|json.*output|JSON\.stringify' src/commands/doctor.ts 2>/dev/null; then
  features=$((features + 1))
fi

if [ "$features" -ge 2 ]; then
  SCORE=2
fi

echo "$SCORE"
