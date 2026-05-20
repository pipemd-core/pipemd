#!/usr/bin/env bash
set -uo pipefail
# React component metadata — exported function components and Props types
source "$(dirname "$0")/../lib/limit.sh"
out=$(grep -rn --include='*.tsx' --include='*.jsx' \
  -E '^export (default )?function [A-Z][A-Za-z]*|^export const [A-Z][A-Za-z]* =|^const [A-Z][A-Za-z]*: React\.FC' \
  src/ 2>/dev/null | grep -v 'node_modules' \
  | sed -E 's/:[0-9]+:.*export (default )?(function |const )([A-Z][A-Za-z]*).*/\3/' \
  | sort -u \
  | head -"$MAX_REACT")
[ -z "$out" ] && echo "No React components found" && exit 0
echo "$out"

props=$(grep -rn --include='*.tsx' --include='*.jsx' \
  -E '(type|interface) [A-Z][A-Za-z]*Props' \
  src/ 2>/dev/null | grep -v 'node_modules' \
  | sed -E 's/.*:(type|interface) ([A-Z][A-Za-z]*Props).*/\2/' \
  | sort -u \
  | head -10)
[ -n "$props" ] && echo "" && echo "Props types:" && echo "$props"