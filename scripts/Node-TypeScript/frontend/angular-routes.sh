#!/usr/bin/env bash
set -uo pipefail
# Angular route metadata — parses *-routing.module.ts files
source "$(dirname "$0")/../lib/limit.sh"
files=$(find src -name '*-routing.module.ts' -o -name '*-routing.module.js' 2>/dev/null | grep -v '/node_modules/')
[ -z "$files" ] && echo "No Angular routing modules found" && exit 0

echo "$files" | while IFS= read -r f; do
  [ -z "$f" ] && continue
  echo "File: $f"
  grep -E '(path|redirectTo)\s*:\s*['\''"][^'\''"]*['\''"]' "$f" 2>/dev/null \
    | sed -E 's/(path|redirectTo)\s*:\s*['\''"]([^'\''"]*)['\''"].*/  \1: \2/' \
    | head -"$MAX_ANGULAR"
  echo ""
done | head -40