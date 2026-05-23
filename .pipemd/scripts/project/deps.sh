#!/usr/bin/env bash
set -uo pipefail
# Direct dependencies (production + dev + peer) — summarize if too many
source "$(dirname "$0")/../lib/limit.sh"
if [ ! -f package.json ]; then
  echo "No package.json found"
  exit 0
fi
out=$(node -e "const p=require('./package.json');const d={...p.dependencies,...p.devDependencies,...p.peerDependencies};if(!Object.keys(d).length){console.log('No dependencies');process.exit()};Object.entries(d).forEach(([k,v])=>console.log(k+' '+v))" 2>/dev/null)
if [ -z "$out" ]; then
  echo "No dependencies found in package.json"
  exit 0
fi
total=$(echo "$out" | wc -l | tr -d '[:space:]')
limit_output "$out" "$MAX_DEPS" "$(echo "$out" | head -5 && echo "... and $total total dependencies")"