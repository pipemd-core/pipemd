#!/usr/bin/env bash
set -uo pipefail
# FastAPI route metadata — endpoint signatures
source "$(dirname "$0")/../lib/limit.sh"
out=$(grep -rn --include='*.py' '@\(app\|router\)\.\(get\|post\|put\|delete\|patch\)' . 2>/dev/null \
  | grep -v '/__pycache__/' | grep -v '/.venv/' | grep -v '/venv/' \
  | sed -E 's/.*@\w+\.(get|post|put|delete|patch)\([[:space:]]*['\''"](\/[^'\''"]*)['\''"].*/\U\1 \2/' \
  | head -"$MAX_FASTAPI")
[ -z "$out" ] && echo "No FastAPI routes detected" && exit 0
echo "$out"