#!/usr/bin/env bash
set -uo pipefail
# Git log — last 10 commits
source "$(dirname "$0")/../lib/limit.sh"
out=$(git log --oneline --date=short --format="%h %ad %s" -10 2>/dev/null | cut -c1-256)
limit_output "$out" "$MAX_LOG" "$(echo "$out" | head -3 && echo '... more commits')"