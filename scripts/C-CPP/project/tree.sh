#!/usr/bin/env bash
set -uo pipefail
# C/C++ project tree — progressive depth fallback with build exclusions
source "$(dirname "$0")/../lib/limit.sh"
limit_tree "$MAX_TREE"