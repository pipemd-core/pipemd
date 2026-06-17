#!/usr/bin/env bash
# report-html.sh — Generate a self-contained HTML report from bench JSONL.
# (v2: 3-condition — WITH / PASSIVE / STATIC. STATIC replaces the old bare WITHOUT.)
#
# Usage: bash bench/report-html.sh <results.jsonl> [output.html]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

INPUT="$1"
if [ ! -f "$INPUT" ]; then
  echo "Error: $INPUT not found" >&2; exit 1
fi

BASENAME="$(basename "$INPUT" .jsonl)"
RESULTS_DIR="$(dirname "$INPUT")"
OUTPUT="${2:-$RESULTS_DIR/report-${BASENAME#run-}.html}"

# Driven by baselines.json when present (authoritative); hardcoded fallback below.
SCENARIO_NAMES='{"1":"Response Cache (Hono / TS)","2":"Parallel Bug (bt-lua / Lua)","3":"Eviction Callback (cachetools / Python)","4":"Compare+Sort (gofrs/uuid / Go)"}'
SCENARIO_TARGETS='{"1":"hono","2":"bt-lua","3":"python","4":"go"}'

node "$SCRIPT_DIR/report-html.mjs" \
  "$INPUT" "$OUTPUT" "$REPO_ROOT" \
  "$SCENARIO_NAMES" "$SCENARIO_TARGETS" \
  "$SCRIPT_DIR/prompts"

echo "Report: $OUTPUT"
