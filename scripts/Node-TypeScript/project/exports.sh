#!/usr/bin/env bash
set -uo pipefail
# Exported symbols per module + env var references
source "$(dirname "$0")/../lib/limit.sh"

if [ ! -d src ]; then
  echo "No src/ directory found"
  exit 0
fi

# Collect full export lines (not just names) so we can show signatures
raw=$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  -E '^export (default |)(function |const |class |type |interface |enum |async function |let |var )[A-Za-z_]' \
  src/ 2>/dev/null | sed 's|^src/||')

if [ -z "$raw" ]; then
  echo "No exports found in src/"
  exit 0
fi

env_vars=$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  -oE 'process\.env\.[A-Za-z_][A-Za-z0-9_]*' \
  src/ 2>/dev/null \
  | sed 's/.*process\.env\.//' \
  | sort -u)

# Format as one line per file: file → sig1, sig2, ...
# Each sig includes type + name (e.g. "function detectProject", "const MAX_RETRIES")
compact=$(echo "$raw" | awk -F: '{
    file=$1; content=$3
    gsub(/^export /, "", content)
    gsub(/;\s*$/, "", content)
    gsub(/\{$/, "", content)
    gsub(/\s+$/, "", content)
    if(length(content) > 80) content = substr(content, 1, 77) "..."
    if(file != prev) {
      if(prev) printf "\n"
      printf "%s:", file
      prev = file; sep = " "
    }
    printf "%s%s", sep, content
    sep = ", "
  }
  END { print "" }')

total=$(echo "$compact" | grep -c ':' || true)

if [ -n "$env_vars" ]; then
  full=$(printf '%s\n\nenv vars: %s' "$compact" "$env_vars")
else
  full="$compact"
fi

limit_output "$full" "$MAX_EXPORTS" "$(echo "$compact" | head -30 && echo "... +$((total > 30 ? total - 30 : 0)) more files")"
