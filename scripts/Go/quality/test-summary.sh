#!/usr/bin/env bash
set -uo pipefail
# Go test summary — go test
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v go &>/dev/null; then
  echo "go not found"
  exit 0
fi

out=$(go test ./... 2>&1 | tail -5)
if [ -z "$out" ]; then
  echo "No test results"
  exit 0
fi
echo "$out"