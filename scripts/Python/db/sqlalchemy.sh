#!/usr/bin/env bash
set -uo pipefail
# SQLAlchemy model metadata — model class names and table names
source "$(dirname "$0")/../lib/limit.sh"
files=$(find . -name '*.py' -not -path '*/venv/*' -not -path '*/.venv/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' 2>/dev/null | head -20)
[ -z "$files" ] && echo "No Python files found" && exit 0

grep -rn --include='*.py' -E 'class [A-Z][A-Za-z0-9_]*\(.*Base.*\)|__tablename__' . 2>/dev/null \
  | grep -v 'venv' | grep -v '.venv' | grep -v '__pycache__' \
  | sed -E 's/.*:class ([A-Z][A-Za-z0-9_]*)\(.*/\1/' \
  | grep -E '^[A-Z]' | sort -u | head -"$MAX_SQLALCHEMY"

tablenames=$(grep -rn --include='*.py' -E '__tablename__' . 2>/dev/null \
  | grep -v 'venv' | grep -v '__pycache__' \
  | sed -E "s/.*__tablename__[[:space:]]*=[[:space:]]*['\"]([^'\"]*)['\"].*/\1/" \
  | sort -u | head -10)
[ -n "$tablenames" ] && echo "" && echo "Tables:" && echo "$tablenames"