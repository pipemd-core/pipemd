#!/usr/bin/env bash
set -uo pipefail
# Auto-detect type checker and run, prioritizing detected ecosystem
source "$(dirname "$0")/../lib/limit.sh"

eco="${PMD_ECOSYSTEM:-}"

case "$eco" in
  Node-TypeScript)
    if [ -f tsconfig.json ] && command -v npx &>/dev/null; then
      out=$(npx tsc --noEmit 2>&1 | head -20)
      if [ -z "$out" ]; then
        echo "No type errors"
        exit 0
      fi
      limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -5 && echo '... more type errors')"
      exit 0
    fi
    echo "No TypeScript compiler found"
    exit 0
    ;;
  Python)
    if command -v mypy &>/dev/null || command -v python &>/dev/null; then
      out=$(python -m mypy . 2>&1 | head -20)
      if [ -z "$out" ]; then
        echo "No type errors"
        exit 0
      fi
      limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -5 && echo '... more mypy errors')"
      exit 0
    fi
    echo "No mypy found"
    exit 0
    ;;
  C-CPP)
    if [ -f CMakeLists.txt ] && [ -d build ]; then
      out=$(cmake --build build 2>&1 | grep -E 'warning:|error:' | head -20)
      if [ -z "$out" ]; then
        echo "No compiler warnings"
        exit 0
      fi
      limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -3 && echo '... more compiler warnings')"
      exit 0
    fi
    echo "No CMake build directory found"
    exit 0
    ;;
  Rust)
    if command -v cargo &>/dev/null && [ -f Cargo.toml ]; then
      out=$(cargo check 2>&1 | grep -E '^error' | head -20)
      if [ -z "$out" ]; then
        echo "No type errors"
        exit 0
      fi
      limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -3 && echo '... more type errors')"
      exit 0
    fi
    echo "No cargo found"
    exit 0
    ;;
  Go)
    if command -v go &>/dev/null && [ -f go.mod ]; then
      out=$(go build ./... 2>&1 | head -20)
      if [ -z "$out" ]; then
        echo "No build errors"
        exit 0
      fi
      limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -3 && echo '... more build errors')"
      exit 0
    fi
    echo "No go found"
    exit 0
    ;;
esac

# Generic: auto-detect
if [ -f tsconfig.json ] && command -v npx &>/dev/null; then
  out=$(npx tsc --noEmit 2>&1 | head -20)
  if [ -z "$out" ]; then
    echo "No type errors"
    exit 0
  fi
  limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -5 && echo '... more type errors')"
elif command -v mypy &>/dev/null || [ -f pyproject.toml ]; then
  out=$(python -m mypy . 2>&1 | head -20)
  if [ -z "$out" ]; then
    echo "No type errors"
    exit 0
  fi
  limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -5 && echo '... more mypy errors')"
elif [ -f CMakeLists.txt ] && [ -d build ]; then
  out=$(cmake --build build 2>&1 | grep -E 'warning:|error:' | head -20)
  if [ -z "$out" ]; then
    echo "No compiler warnings"
    exit 0
  fi
  limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -3 && echo '... more compiler warnings')"
elif command -v cargo &>/dev/null && [ -f Cargo.toml ]; then
  out=$(cargo check 2>&1 | grep -E '^error' | head -20)
  if [ -z "$out" ]; then
    echo "No type errors"
    exit 0
  fi
  limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -3 && echo '... more type errors')"
elif command -v go &>/dev/null && [ -f go.mod ]; then
  out=$(go build ./... 2>&1 | head -20)
  if [ -z "$out" ]; then
    echo "No build errors"
    exit 0
  fi
  limit_output "$out" "$MAX_TYPECHECK" "$(echo "$out" | head -3 && echo '... more build errors')"
else
  echo "No type checker configured for this ecosystem"
fi