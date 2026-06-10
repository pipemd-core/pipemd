#!/usr/bin/env bash
set -uo pipefail
# FastAPI route metadata — endpoint signatures
# Uses ast-grep for structural parsing when available, regex fallback otherwise.
source "$(dirname "$0")/../lib/limit.sh"
source "$(dirname "$0")/../lib/resolve-sg.sh" 2>/dev/null || source "$(cd "$(dirname "$0")/../../Shared" 2>/dev/null && pwd)/lib/resolve-sg.sh" 2>/dev/null || true

if [ -x "$SG" ]; then
  out=""
  for m in get post put delete patch; do
    matches=$("$SG" -p "@\$D.$m(\$PATH)" -l python --json . 2>/dev/null) || continue
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
  out=$(echo "$out" | grep -v '^$' | sort -u | head -"$MAX_FASTAPI")
  [ -z "$out" ] && echo "No FastAPI routes detected" && exit 0
  echo "$out"
else
  out=$(grep -rn --include='*.py' '@\(app\|router\)\.\(get\|post\|put\|delete\|patch\)' . 2>/dev/null \
    | grep -v '/__pycache__/' | grep -v '/.venv/' | grep -v '/venv/' \
    | sed -E 's/.*@\w+\.(get|post|put|delete|patch)\([[:space:]]*['\''"](\/[^'\''"]*)['\''"].*/\U\1 \2/' \
    | head -"$MAX_FASTAPI")
  [ -z "$out" ] && echo "No FastAPI routes detected" && exit 0
  echo "$out"
fi
