#!/usr/bin/env bash
set -uo pipefail
# repomap.sh — Ranked signature map with personalized PageRank
# Shows the most important symbols in the codebase, ranked by reference-graph
# centrality and git recency. Uses ast-grep when available, regex fallback otherwise.
source "$(dirname "$0")/../lib/limit.sh"
source "$(dirname "$0")/../lib/resolve-sg.sh"

: "${MAX_REPOMAP:=${MAX_REPOMAP:-60}}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$SCRIPT_DIR/repomap.mjs"
[ -f "$ENGINE" ] || ENGINE="$SCRIPT_DIR/../../Shared/project/repomap.mjs"

export PMD_SG="${SG:-}"
export PMD_MAX_REPOMAP="$MAX_REPOMAP"

node "$ENGINE"
