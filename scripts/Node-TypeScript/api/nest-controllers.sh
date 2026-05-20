#!/usr/bin/env bash
set -uo pipefail
# NestJS controller metadata — decorators, routes, methods
source "$(dirname "$0")/../lib/limit.sh"
files=$(grep -rl --include='*.ts' '@Controller\|@Get\|@Post\|@Put\|@Delete\|@Patch' src/ 2>/dev/null | grep -v '/node_modules/' | head -10)
[ -z "$files" ] && echo "No NestJS controllers found" && exit 0

echo "$files" | while IFS= read -r f; do
  [ -z "$f" ] && continue
  controller=$(grep -E '@Controller\s*\(\s*['\''"](\/[^'\''"]*)' "$f" 2>/dev/null | sed -E "s/@Controller\s*\(\s*['\"]//;s/['\"].*//")
  methods=$(grep -E '@(Get|Post|Put|Delete|Patch)\s*\(\s*['\''"](\/[^'\''"]*)' "$f" 2>/dev/null | sed -E "s/@(Get|Post|Put|Delete|Patch)\s*\(\s*['\"]//;s/['\"].*//")
  if [ -n "$controller" ]; then
    echo "Controller: $controller"
    echo "$methods" | while IFS= read -r m; do
      [ -n "$m" ] && echo "  $m"
    done
  fi
done | head -"$MAX_NEST"