#!/usr/bin/env bash
# Quality gate — s4 (gofrs/uuid): Compare + Sort.
# Runs INSIDE the per-run worktree. Injects a bench-owned _bench_test.go (same
# package) at grade time, then runs go vet + go test. The Go toolchain is
# expected in PATH; if missing, falls back to ~/.local/go/bin.
#
# Score: 0 = gofmt/vet fail; 1 = clean but tests fail; 2 = tests pass.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BENCH_TESTS="$SCRIPT_DIR/../tests"

command -v go >/dev/null 2>&1 || export PATH="$HOME/.local/go/bin:$PATH"

score=0

# Inject the grade spec into the package dir (same package uuid).
cp "$BENCH_TESTS/uuid_bench_test.go" ./bench_compare_test.go 2>/dev/null || true

# Grade 0: gofmt + go vet must be clean on the agent's own files.
# (bench_compare_test.go is injected by this gate — exclude it from gofmt.)
gofmt_ok=true
gofmt_out="$(gofmt -l *.go 2>/dev/null | grep -v '^bench_compare_test\.go$' || true)"
[ -n "$gofmt_out" ] && gofmt_ok=false
if [ "$gofmt_ok" = true ] && go vet ./... >/dev/null 2>&1; then
  score=1
fi

# Grade 2: the grader tests pass.
if [ "$score" -eq 1 ] && [ -f ./bench_compare_test.go ]; then
  if go test -run 'TestBench' ./... >/dev/null 2>&1; then
    score=2
  fi
fi

rm -f ./bench_compare_test.go 2>/dev/null || true

echo "$score"
