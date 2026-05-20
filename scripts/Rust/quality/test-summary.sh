#!/usr/bin/env bash
set -uo pipefail
# Rust test summary — cargo test
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v cargo &>/dev/null; then
  echo "cargo not found"
  exit 0
fi

out=$(cargo test 2>&1 | tail -5)
if [ -z "$out" ]; then
  echo "No test results"
  exit 0
fi
echo "$out"