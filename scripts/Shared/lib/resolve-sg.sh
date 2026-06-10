#!/usr/bin/env bash
# resolve-sg.sh — locate ast-grep binary
# Sources: PMD_ASTGREP env (set by daemon) > PATH > sg (with version check)
# Usage: source this file, then use $SG (empty string if not found)
if [ -x "${PMD_ASTGREP:-}" ]; then
  SG="$PMD_ASTGREP"
  return 0 2>/dev/null || true
fi
SG=""
_bin=$(command -v ast-grep 2>/dev/null) && [ -x "$_bin" ] && "$_bin" --version 2>/dev/null | grep -q 'ast-grep' && SG="$_bin" && return 0 2>/dev/null || true
_bin=$(command -v sg 2>/dev/null) && [ -x "$_bin" ] && "$_bin" --version 2>/dev/null | grep -q 'ast-grep' && SG="$_bin" && return 0 2>/dev/null || true
