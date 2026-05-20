#!/usr/bin/env bash
set -uo pipefail
# Angular route metadata — route definitions from routing modules
source "$(dirname "$0")/../lib/limit.sh"
files=$(find src -name '*-routing.module.ts' -o -name '*-routing.module.js' 2>/dev/null | grep -v '/node_modules/')
[ -z "$files" ] && echo "No Angular routing modules found" && exit 0
echo "$files" | while IFS= read -r f; do
  [ -z "$f" ] && continue
  echo "=== $f ==="
  grep -E 'path:\s*['\''"]' "$f" 2>/dev/null | sed -E "s/.*path:\s*['\"]([^'\"]+)['\"].*/\1/" | head -10
done | head -"$MAX_ANGULAR"