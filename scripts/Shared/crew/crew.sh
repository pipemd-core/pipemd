#!/usr/bin/env bash
set -uo pipefail
# crew.sh — PipeMD Crew coordination block.
#
# Thin delegator: the heavy logic (session ledger, process scan, conflict
# detection) lives in the `pmd` binary so it stays unit-testable. This script
# only applies the token budget and calls `pmd crew render`.

source "$(dirname "$0")/../lib/limit.sh" 2>/dev/null || MAX_CREW="${PMD_MAX_CREW:-40}"

if command -v pmd >/dev/null 2>&1; then
  output=$(PMD_MAX_CREW="${MAX_CREW:-40}" pmd crew render 2>/dev/null) || exit 0
  lines=$(echo "$output" | grep -c '[^[:space:]]')
  sessions=$(echo "$output" | grep -c '^▸')
  conflicts=$(echo "$output" | grep -c '⚠️ CONFLICT')
  passive=$(echo "$output" | grep -c 'Passive')
  if [ "$sessions" -le 1 ] && [ "$conflicts" -eq 0 ] && [ "$passive" -eq 0 ] && [ "$lines" -le 3 ]; then
    exit 0
  fi
  echo "$output"
else
  echo "_(pmd not on PATH — crew coordination block unavailable)_"
fi
