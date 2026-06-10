#!/usr/bin/env bash
set -uo pipefail
# React component metadata — exported function components and Props types
# Uses ast-grep for structural parsing when available, regex fallback otherwise.
source "$(dirname "$0")/../lib/limit.sh"

_resolve_sg() {
  [ -x "${PMD_ASTGREP:-}" ] && echo "$PMD_ASTGREP" && return
  local bin
  bin=$(command -v ast-grep 2>/dev/null) && [ -x "$bin" ] && "$bin" --version 2>/dev/null | grep -q 'ast-grep' && echo "$bin" && return
  bin=$(command -v sg 2>/dev/null) && [ -x "$bin" ] && "$bin" --version 2>/dev/null | grep -q 'ast-grep' && echo "$bin" && return
}

SG=$(_resolve_sg)

if [ -x "$SG" ]; then
  out=""
  for pat in 'export function $NAME($$$A) { $$$B }' 'export default function $NAME($$$A) { $$$B }' 'export const $NAME: $$$T = $$$R'; do
    names=$("$SG" -p "$pat" -l tsx --json src/ 2>/dev/null | jq -r '.[].metaVariables.single.NAME.text // empty' 2>/dev/null) || continue
    [ -z "$names" ] && continue
    while IFS= read -r n; do
      case "$n" in
        [A-Z]*) out="${out}${n}
" ;;
      esac
    done <<< "$names"
  done
  out=$(echo "$out" | grep -v '^$' | sort -u | head -"$MAX_REACT")
  [ -z "$out" ] && echo "No React components found" && exit 0
  echo "$out"

  props=""
  for pat in 'interface $NAME { $$$B }' 'type $NAME = $$$R'; do
    names=$("$SG" -p "$pat" -l tsx --json src/ 2>/dev/null | jq -r '.[].metaVariables.single.NAME.text // empty' 2>/dev/null) || continue
    while IFS= read -r n; do
      case "$n" in
        *Props) props="${props}${n}
" ;;
      esac
    done <<< "$names"
  done
  props=$(echo "$props" | grep -v '^$' | sort -u | head -10)
  [ -n "$props" ] && echo "" && echo "Props types:" && echo "$props"
else
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
fi
