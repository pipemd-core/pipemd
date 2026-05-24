#!/usr/bin/env bash
set -uo pipefail
# Auto-detect test runner and run, prioritizing detected ecosystem
source "$(dirname "$0")/../lib/limit.sh"

eco="${PMD_ECOSYSTEM:-}"

case "$eco" in
  Node-TypeScript)
    if compgen -G "jest.config.*" &>/dev/null || compgen -G "vitest.config.*" &>/dev/null; then
      out=$(npx jest --no-coverage --silent 2>&1 | tail -5 || npx vitest run --reporter=verbose 2>&1 | tail -5)
      echo "$out"
      exit 0
    fi
    # Fallback: detect test script in package.json
    if [ -f package.json ]; then
      test_cmd=$(node -e "const p=require('./package.json');console.log(p.scripts&&p.scripts['test:unit']?'test:unit':p.scripts&&p.scripts['test']?'test':'')" 2>/dev/null)
      if [ -n "$test_cmd" ]; then
        pkg_mgr="npm"
        [ -f pnpm-lock.yaml ] && pkg_mgr="pnpm"
        [ -f yarn.lock ] && pkg_mgr="yarn"
        out=$("$pkg_mgr" run "$test_cmd" 2>&1 | tail -"$MAX_TEST")
        if [ -n "$out" ]; then
          echo "$out"
          exit 0
        fi
      fi
    fi
    echo "No test runner found"
    exit 0
    ;;
  Python)
    if command -v pytest &>/dev/null || [ -f pytest.ini ] || [ -f conftest.py ]; then
      out=$(python -m pytest --tb=no -q 2>&1 | tail -5)
      echo "$out"
      exit 0
    fi
    echo "No pytest found"
    exit 0
    ;;
  C-CPP)
    if [ -f CMakeLists.txt ] && [ -d build ]; then
      out=$(ctest --test-dir build --output-on-failure 2>&1 | tail -5)
      echo "$out"
      exit 0
    fi
    echo "No CMake test directory found"
    exit 0
    ;;
  Rust)
    if command -v cargo &>/dev/null && [ -f Cargo.toml ]; then
      out=$(cargo test 2>&1 | tail -5)
      echo "$out"
      exit 0
    fi
    echo "No cargo found"
    exit 0
    ;;
  Go)
    if command -v go &>/dev/null && [ -f go.mod ]; then
      out=$(go test ./... 2>&1 | tail -5)
      echo "$out"
      exit 0
    fi
    echo "No go found"
    exit 0
    ;;
esac

# Generic: auto-detect
if compgen -G "jest.config.*" &>/dev/null || compgen -G "vitest.config.*" &>/dev/null; then
  out=$(npx jest --no-coverage --silent 2>&1 | tail -5 || npx vitest run --reporter=verbose 2>&1 | tail -5)
  echo "$out"
elif command -v pytest &>/dev/null || [ -f pytest.ini ] || [ -f conftest.py ]; then
  out=$(python -m pytest --tb=no -q 2>&1 | tail -5)
  echo "$out"
elif command -v cargo &>/dev/null && [ -f Cargo.toml ]; then
  out=$(cargo test 2>&1 | tail -5)
  echo "$out"
elif command -v go &>/dev/null && [ -f go.mod ]; then
  out=$(go test ./... 2>&1 | tail -5)
  echo "$out"
elif [ -f CMakeLists.txt ] && [ -d build ]; then
  out=$(ctest --test-dir build --output-on-failure 2>&1 | tail -5)
  echo "$out"
elif [ -f package.json ]; then
  test_cmd=$(node -e "const p=require('./package.json');console.log(p.scripts&&p.scripts['test:unit']?'test:unit':p.scripts&&p.scripts['test']?'test':'')" 2>/dev/null)
  if [ -n "$test_cmd" ]; then
    pkg_mgr="npm"
    [ -f pnpm-lock.yaml ] && pkg_mgr="pnpm"
    [ -f yarn.lock ] && pkg_mgr="yarn"
    out=$($pkg_mgr run $test_cmd 2>&1 | tail -"$MAX_TEST")
    if [ -n "$out" ]; then
      echo "$out"
    else
      echo "Test runner produced no output"
    fi
  else
    echo "No test runner configured for this ecosystem"
  fi
else
  echo "No test runner configured for this ecosystem"
fi