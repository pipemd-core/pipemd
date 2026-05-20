#!/usr/bin/env bash
set -uo pipefail
# Auto-detect linter and run, prioritizing detected ecosystem
source "$(dirname "$0")/../lib/limit.sh"

eco="${PMD_ECOSYSTEM:-}"

case "$eco" in
  Node-TypeScript)
    if compgen -G ".eslintrc.*" &>/dev/null || compgen -G "eslint.config.*" &>/dev/null; then
      out=$(npx eslint . --format=compact 2>&1 | head -30)
      limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more lint issues')"
      exit 0
    fi
    echo "No ESLint configuration found"
    exit 0
    ;;
  Python)
    if command -v ruff &>/dev/null; then
      out=$(ruff check . 2>&1 | head -30)
      limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more lint issues')"
      exit 0
    elif command -v flake8 &>/dev/null; then
      out=$(flake8 . --count --select=E9,F63,F7,F82 --show-source --statistics 2>&1 | head -30)
      limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more flake8 errors')"
      exit 0
    fi
    echo "No Python linter found"
    exit 0
    ;;
  C-CPP)
    if command -v clang-tidy &>/dev/null; then
      out=$(clang-tidy --checks='-*,bugprone-*,modernize-*,readability-*' -p build . 2>&1 | head -30)
      limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more clang-tidy warnings')"
      exit 0
    fi
    echo "No clang-tidy found"
    exit 0
    ;;
  Rust)
    if command -v cargo &>/dev/null && [ -f Cargo.toml ]; then
      out=$(cargo clippy --message-format=short 2>&1 | grep -E '^(error|warning)\[' | head -30)
      limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more clippy warnings')"
      exit 0
    fi
    echo "No cargo found"
    exit 0
    ;;
  Go)
    if command -v go &>/dev/null && [ -f go.mod ]; then
      out=$(go vet ./... 2>&1 | head -30)
      limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more go vet warnings')"
      exit 0
    fi
    echo "No go found"
    exit 0
    ;;
esac

# Generic: auto-detect
if compgen -G ".eslintrc.*" &>/dev/null || compgen -G "eslint.config.*" &>/dev/null; then
  out=$(npx eslint . --format=compact 2>&1 | head -30)
  limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more lint issues')"
elif command -v ruff &>/dev/null; then
  out=$(ruff check . 2>&1 | head -30)
  limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more lint issues')"
elif command -v flake8 &>/dev/null; then
  out=$(flake8 . --count --select=E9,F63,F7,F82 --show-source --statistics 2>&1 | head -30)
  limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more flake8 errors')"
elif command -v clang-tidy &>/dev/null; then
  out=$(clang-tidy --checks='-*,bugprone-*,modernize-*,readability-*' -p build . 2>&1 | head -30)
  limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more clang-tidy warnings')"
elif command -v cargo &>/dev/null && [ -f Cargo.toml ]; then
  out=$(cargo clippy --message-format=short 2>&1 | grep -E '^(error|warning)\[' | head -30)
  limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more clippy warnings')"
elif command -v go &>/dev/null && [ -f go.mod ]; then
  out=$(go vet ./... 2>&1 | head -30)
  limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more go vet warnings')"
else
  echo "No linter configured for this ecosystem"
fi