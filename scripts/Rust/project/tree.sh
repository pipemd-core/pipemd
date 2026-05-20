#!/usr/bin/env bash
set -uo pipefail
# Rust project tree — progressive depth fallback
source "$(dirname "$0")/../lib/limit.sh"
limit_tree "$MAX_TREE"