#!/usr/bin/env bash
set -uo pipefail
# Git diff stat — truncated with count if large
source "$(dirname "$0")/../lib/limit.sh"
out=$(git diff --stat 2>/dev/null)
limit_output "$out" "$MAX_DIFF" "$(echo "$out" | head -10 && echo "... $(($(echo "$out" | wc -l) - 10)) more files")"