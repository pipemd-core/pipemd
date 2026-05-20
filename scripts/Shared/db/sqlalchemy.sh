#!/usr/bin/env bash
set -uo pipefail
# SQLAlchemy model metadata — model signatures and tables
source "$(dirname "$0")/../lib/limit.sh"
files=$(find . -name '*.py' -not -path '*/venv/*' -not -path '*/.venv/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' 2>/dev/null | head -20)
[ -z "$files" ] && echo "No SQLAlchemy models detected" && exit 0
out=$(echo "$files" | while IFS= read -r f; do
  [ -z "$f" ] && continue
  grep -n 'class.*Model\|__tablename__\|Column(' "$f" 2>/dev/null | head -5
done)
[ -z "$out" ] && echo "No SQLAlchemy models detected" && exit 0
echo "$out" | head -"$MAX_SQLALCHEMY"