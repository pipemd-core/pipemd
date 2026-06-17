#!/usr/bin/env bash
# Quality gate — s3 (cachetools): opt-in eviction callback.
# Runs INSIDE the per-run worktree. Injects a bench-owned pytest spec at grade
# time, runs ruff + pytest against the in-tree source (no venv — cachetools is
# stdlib-only, so PYTHONPATH=src suffices).
#
# Score: 0 = ruff fails; 1 = ruff clean but spec fails; 2 = spec passes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BENCH_TESTS="$SCRIPT_DIR/../tests"

score=0

# Inject the grade spec into the repo's tests dir (agent never sees it before).
[ -d tests ] && cp "$BENCH_TESTS/test_bench_evict.py" tests/test_bench_evict.py 2>/dev/null || true

# Grade 0: ruff must be clean on the file the agent is expected to edit.
# (Scoped to __init__.py — the pristine upstream snapshot has an unrelated
# unused-import warning in func.py that must not leak into the grade.)
if ruff check src/cachetools/__init__.py >/dev/null 2>&1; then
  score=1
fi

# Grade 2: the spec passes.
if [ "$score" -eq 1 ] && [ -f tests/test_bench_evict.py ]; then
  if PYTHONPATH=src python3 -m pytest tests/test_bench_evict.py -q >/dev/null 2>&1; then
    score=2
  fi
fi

rm -f tests/test_bench_evict.py 2>/dev/null || true

echo "$score"
