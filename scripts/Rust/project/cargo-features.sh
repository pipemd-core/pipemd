#!/usr/bin/env bash
set -uo pipefail
# Cargo feature flags — parse [features] from Cargo.toml
source "$(dirname "$0")/../lib/limit.sh"

if [ ! -f Cargo.toml ]; then
  echo "No Cargo.toml found"
  exit 0
fi

out=$(awk '
/^\[features\]/ { in_features=1; next }
/^\[/ { in_features=0 }
in_features && /=/ {
  gsub(/ = .*/, "")
  gsub(/[^a-zA-Z0-9_-]/, "")
  if (length($0) > 0) print $0
}
' Cargo.toml 2>/dev/null)

if [ -z "$out" ]; then
  echo "No features defined in Cargo.toml"
  exit 0
fi

limit_output "$out" "$MAX_CARGO_FEATURES" "$(echo "$out" | head -5 && echo '... more features')"