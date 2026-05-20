#!/usr/bin/env bash
set -uo pipefail
# Cargo dependencies — parse Cargo.toml [dependencies]
source "$(dirname "$0")/../lib/limit.sh"

if [ ! -f Cargo.toml ]; then
  echo "No Cargo.toml found"
  exit 0
fi

out=$(awk '
/^\[dependencies\]/ { in_deps=1; next }
/^\[/ { in_deps=0 }
in_deps && /^[a-zA-Z_-]/ {
  gsub(/=.*/, "")
  gsub(/[^a-zA-Z0-9_-]/, "")
  if (length($0) > 0) print $0
}
' Cargo.toml 2>/dev/null | head -"$MAX_DEPS")

if [ -z "$out" ]; then
  echo "No dependencies found in Cargo.toml"
  exit 0
fi

echo "$out"

dev_out=$(awk '
/^\[dev-dependencies\]/ { in_dev=1; next }
/^\[/ { in_dev=0 }
in_dev && /^[a-zA-Z_-]/ {
  gsub(/=.*/, "")
  gsub(/[^a-zA-Z0-9_-]/, "")
  if (length($0) > 0) print $0
}
' Cargo.toml 2>/dev/null | head -10)

if [ -n "$dev_out" ]; then
  echo ""
  echo "Dev dependencies:"
  echo "$dev_out"
fi