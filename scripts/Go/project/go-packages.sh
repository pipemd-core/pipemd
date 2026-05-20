#!/usr/bin/env bash
set -uo pipefail
# Go packages — list packages from go.mod and source directories
source "$(dirname "$0")/../lib/limit.sh"

if [ ! -f go.mod ]; then
  echo "No go.mod found"
  exit 0
fi

module=$(awk '/^module /{print $2}' go.mod 2>/dev/null | head -1)
if [ -n "$module" ]; then
  echo "Module: $module"
fi

out=$(find . -name "*.go" -not -path "*/vendor/*" -not -path "*/.git/*" 2>/dev/null \
  | xargs grep -l "^package " 2>/dev/null \
  | sed 's|/[^/]*\.go$||;s|^\./||' \
  | sort -u \
  | head -"$MAX_GO_PKGS")

if [ -z "$out" ]; then
  echo "No Go packages found"
  exit 0
fi

echo "Packages:"
echo "$out"