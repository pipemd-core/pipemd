#!/usr/bin/env bash
set -uo pipefail
# Current branch and tracking info
source "$(dirname "$0")/../lib/limit.sh"

if ! git rev-parse --git-dir &>/dev/null; then
  exit 0
fi

branch=$(git branch --show-current 2>/dev/null)
tracking=$(git rev-list --left-right --count HEAD...@'{u}' 2>/dev/null | awk '{print "ahead " $1 ", behind " $2}')

if [ -n "$branch" ]; then
  echo "$branch"
else
  echo "detached HEAD at $(git rev-parse --short HEAD 2>/dev/null)"
fi

if [ -n "$tracking" ]; then
  echo "$tracking"
else
  # Distinguish "no upstream tracking configured" (push may still work via remote)
  # from "no remote at all" — the old "no upstream" wording read as "can't push".
  if git remote get-url origin >/dev/null 2>&1; then
    echo "no upstream tracking (origin remote exists; push may still work)"
  else
    echo "no upstream configured"
  fi
fi