#!/usr/bin/env bash
set -uo pipefail
# Test summary — actually run tests and show results
source "$(dirname "$0")/../lib/limit.sh"

if command -v pytest &>/dev/null || [ -f pytest.ini ] || [ -f conftest.py ] || [ -f pyproject.toml ]; then
  out=$(python -m pytest --tb=no -q 2>&1 | tail -5)
  echo "$out"
else
  echo "No test runner configured for this ecosystem"
fi