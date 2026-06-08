#!/usr/bin/env bash
set -uo pipefail
# Angular route metadata — parses *-routing.module.ts AND standalone *.routes.ts files
source "$(dirname "$0")/../lib/limit.sh"

module_files=$(find src -name '*-routing.module.ts' -o -name '*-routing.module.js' 2>/dev/null | grep -v '/node_modules/')
standalone_files=$(find src -name '*.routes.ts' -o -name '*.routes.js' 2>/dev/null | grep -v '/node_modules/')
files="$module_files"
[ -n "$standalone_files" ] && files="${files:+$files$'\n'}$standalone_files"
[ -z "$files" ] && echo "No Angular route definitions found" && exit 0

echo "$files" | sort -u | while IFS= read -r f; do
  [ -z "$f" ] && continue
  echo "File: $f"
  grep -E '(path|redirectTo)\s*:\s*['\''"][^'\''"]*['\''"]' "$f" 2>/dev/null \
    | sed -E 's/(path|redirectTo)\s*:\s*['\''"]([^'\''"]*)['\''"].*/  \1: \2/' \
    | head -"$MAX_ANGULAR"
  echo ""
done | head -40