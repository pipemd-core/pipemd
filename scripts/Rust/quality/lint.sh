#!/usr/bin/env bash
set -uo pipefail
# Rust lint — cargo clippy
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v cargo &>/dev/null; then
  echo "cargo not found"
  exit 0
fi

out=$(cargo clippy --message-format=short 2>&1 | grep -E '^(error|warning)\[' | head -30)
if [ -z "$out" ]; then
  echo "No clippy warnings"
  exit 0
fi
limit_output "$out" "$MAX_LINT" "$(echo "$out" | head -3 && echo '... more clippy warnings')"