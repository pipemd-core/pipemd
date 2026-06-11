#!/usr/bin/env bash
# Quality check for scenario 01: pmd crew export command
# Runs INSIDE a git worktree of the pipemd repo
set -euo pipefail

SCORE=0

# Grade 0 check: does it compile?
if ! npx tsc --noEmit 2>/dev/null; then
  echo "0"
  exit 0
fi
SCORE=1

# Grade 2 check: look for a new crew export subcommand
# Must have "export" as a subcommand/action in the crew command area
# AND must produce JSON output (JSON.stringify or similar)

# Check for new or modified files that contain crew export logic
# Look for explicit subcommand registration: .command('export') or exportCommand
if grep -rq "\.command.*['\"]export['\"]\|exportCommand\|'crew export'\|\"crew export\"" src/commands/ --include='*.ts' 2>/dev/null; then
  # Check that it reads actual session data
  if grep -rq 'readSession\|listSessions' src/commands/ --include='*.ts' 2>/dev/null; then
    # Check that it outputs JSON
    if grep -rq 'JSON.stringify\|json.*output\|console.*JSON' src/commands/ --include='*.ts' 2>/dev/null; then
      SCORE=2
    fi
  fi
fi

echo "$SCORE"
