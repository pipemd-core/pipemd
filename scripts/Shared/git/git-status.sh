#!/usr/bin/env bash
set -uo pipefail
# Git status — summary counts if too many files
source "$(dirname "$0")/../lib/limit.sh"
out=$(git status --short --branch 2>/dev/null)
limit_output "$out" "$MAX_STATUS" "$(echo "$out" | head -5; echo "... and $(($(echo "$out" | wc -l) - 5)) more changes")"