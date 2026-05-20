#!/usr/bin/env bash
set -uo pipefail
# React component metadata — exported function components and Props types
source "$(dirname "$0")/../lib/limit.sh"
out=$(grep -rn --include='*.tsx' --include='*.jsx' \
  -E '^export (default )?function [A-Z][A-Za-z]*|^export const [A-Z][A-Za-z]* =|^const [A-Z][A-Za-z]*: React\.FC' \
  . 2>/dev/null | grep -v 'node_modules' \
  | sed -E 's/:[0-9]+:.*export (default )?(function |const )([A-Z][A-Za-z]*).*/\3/' \
  | sort -u | head -"$MAX_REACT")
[ -z "$out" ] && echo "No React components detected" && exit 0
echo "$out"