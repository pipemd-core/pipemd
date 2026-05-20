#!/usr/bin/env bash
set -uo pipefail
# Express route metadata — method + path signatures
source "$(dirname "$0")/../lib/limit.sh"
out=$(grep -rn --include='*.js' --include='*.ts' --include='*.mjs' \
  -E '(app|router)\.(get|post|put|delete|patch|all)\(' \
  src/ routes/ app/ lib/ 2>/dev/null | grep -v 'node_modules' \
  | sed -E 's/.*\.(get|post|put|delete|patch|all)\([[:space:]]*['\''"](\/[^'\''"]*)['\''"].*/\U\1 \2/' \
  | head -"$MAX_EXPRESS")
if [ -z "$out" ]; then
  echo "No Express routes found"
  exit 0
fi
echo "$out"