#!/usr/bin/env bash
set -uo pipefail
# Django model metadata — model names and field summaries
source "$(dirname "$0")/../lib/limit.sh"
files=$(find . -name 'models.py' -not -path '*/venv/*' -not -path '*/.venv/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' 2>/dev/null | head -10)
[ -z "$files" ] && echo "No Django models.py found" && exit 0

echo "$files" | while IFS= read -r f; do
  [ -z "$f" ] && continue
  echo "=== $f ==="
  awk '/^class [A-Z]/{gsub(/\(.*/,"",$0); print "Model: "$2; next} /^[[:space:]]+[a-z_]+ = models\./{gsub(/ = .*/,"",$1); print "  "$1; next}' "$f" | head -"$MAX_DJANGO"
done | head -50