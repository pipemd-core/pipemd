#!/usr/bin/env bash
set -uo pipefail
# Next.js App Router route tree — extracts routes from app/**/page.tsx
source "$(dirname "$0")/../lib/limit.sh"
[ ! -d "app" ] && echo "No Next.js app/ directory found" && exit 0

find app -name 'page.tsx' -o -name 'page.ts' -o -name 'page.jsx' -o -name 'page.js' 2>/dev/null \
  | sed 's|^app||;s|/page\.\(tsx\|ts\|jsx\|js\)$||;s|^$|/|' \
  | sort \
  | head -"$MAX_NEXTJS"

layouts=$(find app -name 'layout.tsx' -o -name 'layout.ts' 2>/dev/null | wc -l)
echo "(${layouts} layout(s), $(find app -name 'page.*' 2>/dev/null | wc -l) route(s))"