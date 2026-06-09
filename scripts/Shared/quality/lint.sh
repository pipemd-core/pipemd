#!/usr/bin/env bash
set -uo pipefail
# Auto-detect linter and run, compact summary-first format
source "$(dirname "$0")/../lib/limit.sh"
source "$(dirname "$0")/../lib/lint-compact.sh"

eco="${PMD_ECOSYSTEM:-}"

case "$eco" in
  Node-TypeScript)
    if compgen -G ".eslintrc.*" &>/dev/null || compgen -G "eslint.config.*" &>/dev/null; then
      compact_eslint "$MAX_LINT"
    else
      echo "No ESLint configuration found"
    fi
    ;;
  Python)
    if command -v ruff &>/dev/null; then
      compact_ruff "$MAX_LINT"
    elif command -v flake8 &>/dev/null; then
      compact_flake8 "$MAX_LINT"
    else
      echo "No Python linter found"
    fi
    ;;
  C-CPP)
    if command -v clang-tidy &>/dev/null; then
      compact_clang_tidy "$MAX_LINT"
    elif command -v cppcheck &>/dev/null; then
      compact_cppcheck "$MAX_LINT"
    else
      echo "No C/C++ linter found"
    fi
    ;;
  Rust)
    if command -v cargo &>/dev/null && [ -f Cargo.toml ]; then
      compact_clippy "$MAX_LINT"
    else
      echo "No cargo found"
    fi
    ;;
  Go)
    if command -v go &>/dev/null && [ -f go.mod ]; then
      compact_go_vet "$MAX_LINT"
    else
      echo "No go found"
    fi
    ;;
  *)
    if compgen -G ".eslintrc.*" &>/dev/null || compgen -G "eslint.config.*" &>/dev/null; then
      compact_eslint "$MAX_LINT"
    elif command -v ruff &>/dev/null; then
      compact_ruff "$MAX_LINT"
    elif command -v flake8 &>/dev/null; then
      compact_flake8 "$MAX_LINT"
    elif command -v clang-tidy &>/dev/null; then
      compact_clang_tidy "$MAX_LINT"
    elif command -v cargo &>/dev/null && [ -f Cargo.toml ]; then
      compact_clippy "$MAX_LINT"
    elif command -v go &>/dev/null && [ -f go.mod ]; then
      compact_go_vet "$MAX_LINT"
    else
      echo "No linter configured for this ecosystem"
    fi
    ;;
esac
