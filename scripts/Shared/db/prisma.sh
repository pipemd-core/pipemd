#!/usr/bin/env bash
set -uo pipefail
# Prisma model metadata — model names, field counts, enums
source "$(dirname "$0")/../lib/limit.sh"
SCHEMA=""
for f in prisma/schema.prisma src/prisma/schema.prisma; do
  [ -f "$f" ] && SCHEMA="$f" && break
done
[ -z "$SCHEMA" ] && echo "No prisma schema found" && exit 0

out=""
in_model=0; model=""; fields=0
while IFS= read -r line; do
  if [[ "$line" =~ ^model[[:space:]]+([A-Za-z_][A-Za-z0-9_]*) ]]; then
    in_model=1; model="${BASH_REMATCH[1]}"; fields=0
  elif [[ "$line" =~ ^enum[[:space:]]+([A-Za-z_][A-Za-z0-9_]*) ]]; then
    in_model=0; enum_name="${BASH_REMATCH[1]}"; enum_vals=""
  elif (( in_model )); then
    if [[ "$line" =~ ^[[:space:]]+@@ ]]; then
      continue
    elif [[ "$line" =~ ^[[:space:]]+[a-zA-Z] ]]; then
      (( fields++ ))
    elif [[ "$line" =~ ^\} ]]; then
      out+="${model} (${fields} fields)\n"
      in_model=0
    fi
  fi
done < "$SCHEMA"

# Extract enums separately
awk '/^enum[[:space:]]/{e=$2;v="";next} /^[[:space:]]+[A-Z]/{v=v?v","$1:$1} /^\}/{if(e)print "enum "e" = ["v"]";e=""}' "$SCHEMA"

printf '%b' "$out" | head -"$MAX_PRISMA"