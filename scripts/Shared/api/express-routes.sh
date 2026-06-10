#!/usr/bin/env bash
set -uo pipefail
# Express route metadata — method + path signatures
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
  for m in get post put delete patch all; do
    matches=$("$SG" -p "\$OBJ.$m(\$PATH, \$\$REST)" -l typescript --json . 2>/dev/null) || continue
    paths=$(echo "$matches" | jq -r '.[] | .metaVariables.single.PATH.text // empty' 2>/dev/null | sed "s/^[\"'\`]//;s/[\"'\`]$//") || continue
    [ -z "$paths" ] && continue
    upper_m=$(echo "$m" | tr '[:lower:]' '[:upper:]')
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      case "$p" in
        /*) ;;
        *) continue ;;
      esac
      out="${out}${upper_m} $(echo "$p" | tr '[:lower:]' '[:upper:]')
"
    done <<< "$paths"
  done
  out=$(echo "$out" | grep -v '^$' | sort -u | head -"$MAX_EXPRESS")
  [ -z "$out" ] && echo "No Express routes found" && exit 0
  echo "$out"
else
  out=$(grep -rn --include='*.js' --include='*.ts' --include='*.mjs' \
    -E '(app|router)\.(get|post|put|delete|patch|all)\(' \
    . 2>/dev/null | grep -v 'node_modules' \
    | sed -E 's/.*\.(get|post|put|delete|patch|all)\([[:space:]]*['\''"](\/[^'\''"]*)['\''"].*/\U\1 \2/' \
    | head -"$MAX_EXPRESS")
  [ -z "$out" ] && echo "No Express routes found" && exit 0
  echo "$out"
fi
