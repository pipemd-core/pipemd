#!/usr/bin/env bash
set -uo pipefail

resolve_knip() {
  [ -x "${PMD_KNIP:-}" ] && echo "$PMD_KNIP" && return
  local bin
  bin="./node_modules/.bin/knip"
  [ -x "$bin" ] && echo "$bin" && return
  bin=$(command -v knip 2>/dev/null)
  [ -x "$bin" ] && echo "$bin" && return
  return 1
}

KNIP=$(resolve_knip) || {
  echo "No dead-code scanner found — install knip for unused-export detection"
  exit 0
}

raw=$("$KNIP" --reporter json 2>/dev/null || true)

if [ -z "$raw" ]; then
  echo "No unused exports, files, or dependencies found"
  exit 0
fi

echo "$raw" | node "$(dirname "$0")/format-knip.mjs"
