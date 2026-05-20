#!/usr/bin/env bash
set -uo pipefail
# FastAPI route metadata — endpoint signatures
source "$(dirname "$0")/../lib/limit.sh"
out=$(grep -rn --include='*.py' \
  -E '@(app|router|APIRouter)\.(get|post|put|delete|patch)\(' \
  . 2>/dev/null \
  | grep -v 'venv' | grep -v '.venv' | grep -v '__pycache__' \
  | sed -E 's/.*@(app|router|APIRouter)\.(get|post|put|delete|patch)\(\s*['\''"](\/[^'\''"]*)['\''"].*/\U\2 \3/' \
  | head -"$MAX_FASTAPI")
[ -z "$out" ] && echo "No FastAPI routes found" && exit 0
echo "$out"