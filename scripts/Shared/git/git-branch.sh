#!/usr/bin/env bash
set -uo pipefail
# Current branch and tracking info
source "$(dirname "$0")/../lib/limit.sh"
branch=$(git branch --show-current 2>/dev/null)
tracking=$(git rev-list --left-right --count HEAD...@'{u}' 2>/dev/null | awk '{print "ahead " $1 ", behind " $2}')
if [ -n "$branch" ]; then
  echo "$branch"
  if [ -n "$tracking" ]; then
    echo "$tracking"
  else
    echo "no upstream"
  fi
else
  echo "not a git repository"
fi