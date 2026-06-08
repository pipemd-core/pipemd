#!/usr/bin/env bash
set -uo pipefail
# Exported symbols per module + env var references
source "$(dirname "$0")/../lib/limit.sh"

if [ ! -d src ]; then
  echo "No src/ directory found"
  exit 0
fi

exports=$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  -oE '^export (default |)(function |const |class |type |interface |enum |async function |let |var )[A-Za-z_][A-Za-z0-9_]*' \
  src/ 2>/dev/null \
  | sed 's|^src/||' \
  | awk -F: '{
      file=$1; name=$3
      gsub(/^export (default )?(function |const |class |type |interface |enum |async function |let |var )/, "", name)
      if(file != prev) {
        if(prev) print ""
        printf "%s:", file
        prev = file; first = 1
      }
      if(!first) printf ", "
      printf "%s", name
      first = 0
    }
    END { print "" }')

if [ -z "$exports" ]; then
  echo "No exports found in src/"
  exit 0
fi

env_vars=$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  -oE 'process\.env\.[A-Za-z_][A-Za-z0-9_]*' \
  src/ 2>/dev/null \
  | sed 's/.*process\.env\.//' \
  | sort -u)

total=$(echo "$exports" | grep -c ':' || true)

if [ -n "$env_vars" ]; then
  full=$(printf '%s\n\nenv vars: %s' "$exports" "$env_vars")
else
  full="$exports"
fi

limit_output "$full" "$MAX_EXPORTS" "$(echo "$exports" | head -10 && echo "... and $total modules")"
