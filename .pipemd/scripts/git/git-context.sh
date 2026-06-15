#!/usr/bin/env bash
set -uo pipefail
# git-context — Unified git context block
# Consolidates branch, log, status, diff-stat into a single parametrable block.
# Controlled by PMD_GIT_SECTIONS (comma-separated: branch,log,status; default: all)
# and MAX_GIT_CONTEXT (total line budget from limit-core.sh).
source "$(dirname "$0")/../lib/limit.sh"

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  exit 0
fi

: "${PMD_GIT_SECTIONS:=branch,log,status}"
: "${MAX_GIT_CONTEXT:=${MAX_GIT_CONTEXT:-35}}"

section_enabled() {
  echo ",$PMD_GIT_SECTIONS," | grep -q ",$1,"
}

total_lines=0
output=""

if section_enabled "branch"; then
  branch=$(git branch --show-current 2>/dev/null)
  if [ -z "$branch" ]; then
    commit=$(git rev-parse --short HEAD 2>/dev/null)
    branch="detached HEAD at ${commit:-unknown}"
  fi
  tracking=$(git rev-list --left-right --count HEAD...@'{u}' 2>/dev/null \
    | awk '{print "ahead " $1 ", behind " $2}')
  output+="## branch"$'\n'
  output+="$branch"$'\n'
  if [ -n "$tracking" ]; then
    output+="$tracking"$'\n'
  fi
  total_lines=$((total_lines + 3))
fi

if section_enabled "log"; then
  budget=$((MAX_GIT_CONTEXT - total_lines - 3))
  if [ "$budget" -gt 0 ]; then
    count=$((budget < 8 ? budget : 8))
    log_out=$(git log --oneline --date=short --format="%h %ad %s" -"$count" 2>/dev/null | cut -c1-120)
    if [ -n "$log_out" ]; then
      log_lines=$(echo "$log_out" | wc -l)
      output+=$'\n'"## recent ($log_lines commits)"$'\n'
      output+="$log_out"$'\n'
      total_lines=$((total_lines + log_lines + 2))
    fi
  fi
fi

if section_enabled "status"; then
  budget=$((MAX_GIT_CONTEXT - total_lines - 2))
  if [ "$budget" -gt 0 ]; then
    status_out=$(git status --short 2>/dev/null)
    if [ -n "$status_out" ]; then
      status_lines=$(echo "$status_out" | wc -l)
      diff_out=$(git diff --stat 2>/dev/null | tail -1)
      output+=$'\n'"## changes ($status_lines files)"$'\n'
      if [ "$status_lines" -le "$budget" ]; then
        output+="$status_out"$'\n'
      else
        output+=$(echo "$status_out" | head -"$((budget - 2))")$'\n'
        output+="... and $((status_lines - budget + 2)) more"$'\n'
      fi
      if [ -n "$diff_out" ]; then
        output+="$diff_out"$'\n'
      fi
      total_lines=$((total_lines + status_lines + 3))
    fi
  fi
fi

if [ -n "$output" ]; then
  printf '%s' "$output" | head -"$MAX_GIT_CONTEXT"
fi
