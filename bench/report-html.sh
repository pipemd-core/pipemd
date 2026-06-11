#!/usr/bin/env bash
# report-html.sh — Generate a self-contained HTML report from bench JSONL
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

SCENARIO_NAMES='{"1":"Crew Export (PipeMD)","2":"Timing Middleware (Hono)","3":"Error Handler (Hono)"}'
SCENARIO_TARGETS='{"1":"pipemd","2":"hono","3":"hono"}'

node "$SCRIPT_DIR/report-html.mjs" \
  "$INPUT" "$OUTPUT" "$REPO_ROOT" \
  "$SCENARIO_NAMES" "$SCENARIO_TARGETS" \
  "$SCRIPT_DIR/prompts"

echo "Report: $OUTPUT"
