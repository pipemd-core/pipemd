#!/usr/bin/env bash
set -uo pipefail
# Direct dependencies — summarize if too many
source "$(dirname "$0")/../lib/limit.sh"

if [ -f requirements.txt ]; then
  out=$(head -20 requirements.txt)
  limit_output "$out" "$MAX_DEPS" "$(head -5 requirements.txt && echo "... and $(wc -l < requirements.txt) total lines")"
elif [ -f pyproject.toml ]; then
  out=$(awk '
    /^\[project\.dependencies\]/{in_deps=1;next}
    /^\[/{in_deps=0}
    in_deps && /^[a-zA-Z]/{
      gsub(/#.*/,"")
      gsub(/;.*$/,"")
      gsub(/"/,"")
      sub(/[<=>!].*/,"")
      if(length>0) print
    }
  ' pyproject.toml 2>/dev/null)
  if [ -n "$out" ]; then
    limit_output "$out" "$MAX_DEPS" "$(echo "$out" | head -5 && echo '... more in pyproject.toml')"
  else
    echo "No dependencies found in pyproject.toml"
  fi
else
  echo "No recognized dependency file"
fi