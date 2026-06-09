#!/usr/bin/env bash
set -uo pipefail
# Django URL patterns — route definitions from urls.py files
source "$(dirname "$0")/../lib/limit.sh"

: "${MAX_DJANGO_URLS:=${MAX_DJANGO_URLS:-40}}"

files=$(find . -name 'urls.py' -not -path '*/venv/*' -not -path '*/.venv/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' -not -path '*/site-packages/*' 2>/dev/null | head -10)
[ -z "$files" ] && echo "No Django urls.py found" && exit 0

echo "$files" | while IFS= read -r f; do
  [ -z "$f" ] && continue
  echo "=== $f ==="
  awk '
    /urlpatterns *= *\[/ {in_patterns=1; next}
    in_patterns && /^\]/ {in_patterns=0; next}
    in_patterns && /^[[:space:]]*#/ {next}
    in_patterns && /(path|re_path)\(/ {
      gsub(/^[[:space:]]+/, "")
      sub(/,[[:space:]]*$/, "")
      print
    }
  ' "$f" 2>/dev/null | while IFS= read -r line; do
    path_val=$(echo "$line" | sed -n "s/.*path(['\"]\\([^'\"]*\\)['\"].*/\\1/p")
    if [ -z "$path_val" ]; then
      case "$line" in *path\(\'\'*) path_val="/" ;; esac
    fi
    [ -z "$path_val" ] && path_val=$(echo "$line" | sed -n "s/.*re_path(['\"]\\([^'\"]*\\)['\"].*/\\1/p")
    include_val=$(echo "$line" | sed -n "s/.*include(['\"]\\([^'\"]*\\)['\"].*/\\1/p")
    [ -z "$include_val" ] && include_val=$(echo "$line" | sed -n 's/.*include(\([^)]*\)).*/\1/p')
    include_val=$(echo "$include_val" | sed "s/^['\"]//;s/['\"]$//")
    if [ -n "$path_val" ]; then
      if [ -n "$include_val" ]; then
        echo "  /${path_val} → ${include_val}"
      else
        echo "  /${path_val}"
      fi
    fi
  done | head -"$MAX_DJANGO_URLS"
  echo ""
done | head -"$MAX_DJANGO_URLS"
