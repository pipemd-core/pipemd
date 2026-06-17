#!/usr/bin/env bash
# Quality gate — s1 (hono): in-memory response-cache middleware.
# Runs INSIDE the per-run worktree. Injects a bench-owned vitest spec at grade
# time (the agent never sees it during exploration), then runs tsc + vitest.
#
# Score: 0 = tsc fails; 1 = tsc clean but spec fails; 2 = spec passes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BENCH_TESTS="$SCRIPT_DIR/../tests"
TARGET_DIR="src/middleware/response-cache"

score=0

# Inject the grade spec next to the agent's implementation.
if [ -d "$TARGET_DIR" ]; then
  cp "$BENCH_TESTS/response-cache.test.ts" "$TARGET_DIR/response-cache.test.ts" 2>/dev/null || true
fi

# Grade 0: project must typecheck.
if npx tsc --noEmit >/dev/null 2>&1; then
  score=1
fi

# Grade 2: the spec must pass (only meaningful if tsc is clean + impl exists).
if [ "$score" -eq 1 ] && [ -f "$TARGET_DIR/index.ts" ] && [ -f "$TARGET_DIR/response-cache.test.ts" ]; then
  if npx vitest run --no-coverage "$TARGET_DIR/response-cache.test.ts" >/dev/null 2>&1; then
    score=2
  fi
fi

# Remove the injected spec so any git-status inspection reflects the agent only.
rm -f "$TARGET_DIR/response-cache.test.ts" 2>/dev/null || true

echo "$score"
