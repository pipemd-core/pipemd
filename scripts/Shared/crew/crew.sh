#!/usr/bin/env bash
set -uo pipefail
# crew.sh — PipeMD Crew coordination block.
#
# Thin delegator: the heavy logic (session ledger, process scan, conflict
# detection) lives in the `pmd` binary so it stays unit-testable. This script
# only applies the token budget and calls `pmd crew render`.

source "$(dirname "$0")/../lib/limit.sh" 2>/dev/null || MAX_CREW="${PMD_MAX_CREW:-40}"

if command -v pmd >/dev/null 2>&1; then
  PMD_MAX_CREW="${MAX_CREW:-40}" pmd crew render 2>/dev/null || echo "_(crew block unavailable)_"
else
  echo "_(pmd not on PATH — crew coordination block unavailable)_"
fi
