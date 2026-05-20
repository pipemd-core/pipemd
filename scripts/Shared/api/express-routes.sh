#!/usr/bin/env bash
set -uo pipefail
# Express route metadata — method + path signatures
source "$(dirname "$0")/../lib/limit.sh"
out=$(grep -rn --include='*.js' --include='*.ts' --include='*.mjs' \
  -E '(app|router)\.(get|post|put|delete|patch|all)\(' \
  . 2>/dev/null | grep -v 'node_modules' \
  | sed -E 's/.*\.(get|post|put|delete|patch|all)\([[:space:]]*['\''"](\/[^'\''"]*)['\''"].*/\U\1 \2/' \
  | head -"$MAX_EXPRESS")
[ -z "$out" ] && echo "No Express routes found" && exit 0
echo "$out"