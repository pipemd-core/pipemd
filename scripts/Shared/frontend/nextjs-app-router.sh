#!/usr/bin/env bash
set -uo pipefail
# Next.js App Router route tree — page.tsx files
source "$(dirname "$0")/../lib/limit.sh"
if [ ! -d app ]; then
  echo "No Next.js app/ directory found"
  exit 0
fi
out=$(find app -name 'page.tsx' -o -name 'page.ts' -o -name 'page.jsx' -o -name 'page.js' 2>/dev/null \
  | sed 's|^app||;s|/page\.\(tsx\|ts\|jsx\|js\)$||;s|^$|/|' \
  | sort)
[ -z "$out" ] && echo "No Next.js pages found" && exit 0
echo "$out" | head -"$MAX_NEXTJS"