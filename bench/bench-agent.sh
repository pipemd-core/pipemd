#!/usr/bin/env bash
# bench-agent.sh — PipeMD Agent A/B Benchmark Runner (v2: multi-ecosystem)
#
# Runs N scenarios × 3 conditions × N repetitions.
#   with    = PipeMD daemon + opencode plugin + live <!-- pmd: --> injection
#   passive = frozen rendered AGENTS.md snapshot (daemon killed after one render)
#   static  = a hand-written-style AGENTS.md (no pmd blocks) — the realistic control
#
# The "static" arm replaces the old "without" (bare) arm: 99% of real projects ship
# a static AGENTS.md, so the honest product question is "does *dynamic* injection
# beat a *normal static* AGENTS.md?" (WITH vs STATIC), not "PipeMD vs nothing".
#
# Targets span ecosystems: hono (TypeScript), bt-lua (Lua), cachetools (Python),
# gofrs/uuid (Go). Each scenario is middle-length and graded by a NATIVE gate
# (tsc+vitest / lua / pytest / go test) — never a grep.
#
# Usage:
#   bash bench/bench-agent.sh [--runs N] [--model MODEL] [--scenarios 1,2,3,4]
#                             [--gen-model MODEL] [--no-gen] [--dry-run]
#   bash bench/bench-agent.sh --resume <results.jsonl>
#   bash bench/bench-agent.sh --report <results.jsonl>
#
# Prerequisites:
#   - opencode in PATH
#   - bun/pnpm (hono), python3+ruff (cachetools), lua (bt-lua), go (gofrs/uuid)
#   - PipeMD daemon NOT running in $REPO_ROOT (script controls it per worktree)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
RUNS=3
MODEL="zai-coding-plan/glm-5.1"
SCENARIOS="1,2,3,4,5"
DRY_RUN=false
REPORT_ONLY=""
GEN_MODEL="${PMD_GEN_MODEL:-zai-coding-plan/glm-5.1}"
NO_GEN=false
CONDITIONS="with,passive,static"

RETROSPECTIVE_PROMPT="You just completed a task using PipeMD context (the AGENTS.md file with <!-- pmd: --> blocks). Give honest, concise feedback in a numbered list.

1. Which pmd: blocks were actually useful? Which did you ignore?
2. Did any block return stale, empty, or misleading data?
3. What did you need that no block provided?
4. Were there moments you explored the codebase manually for something that should have been in context?
5. Any block that felt like wasted tokens?

Be brutally honest — flattery is useless. One sentence per point max. If you did NOT receive a pipemd AGENTS.md (no pmd: blocks), say so in point 1 and skip the rest."

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --scenarios) SCENARIOS="$2"; shift 2 ;;
    --gen-model) GEN_MODEL="$2"; shift 2 ;;
    --no-gen) NO_GEN=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --conditions) CONDITIONS="$2"; shift 2 ;;
    --report)
      if [ -z "${2:-}" ]; then echo "Usage: --report <results.jsonl>"; exit 1; fi
      REPORT_ONLY="$2"; shift 2 ;;
    --resume)
      if [ -z "${2:-}" ]; then echo "Usage: --resume <results.jsonl>"; exit 1; fi
      RESUME_FILE="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
Usage: bash bench/bench-agent.sh [--runs N] [--model MODEL] [--scenarios 1,2,3,4]
                                 [--conditions with,static] [--gen-model MODEL] [--no-gen] [--dry-run]
       bash bench/bench-agent.sh --resume <results.jsonl>
       bash bench/bench-agent.sh --report <results.jsonl>
Conditions: with (live), passive (frozen snapshot), static (hand-written AGENTS.md)
EOF
      exit 0 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Report-only mode
if [ -n "$REPORT_ONLY" ]; then
  bash "$SCRIPT_DIR/report-html.sh" "$REPORT_ONLY"
  exit $?
fi

# --- Toolchain PATH -------------------------------------------------------
# Use THIS worktree's built pmd (the product under test) rather than whatever
# global pmd is in PATH. The wrapper at bench/.pmd-bin/pmd execs ../../dist.
export PATH="$SCRIPT_DIR/.pmd-bin:$PATH"
# Go toolchain (installed locally for the bench; not assumed on PATH).
command -v go >/dev/null 2>&1 || export PATH="$HOME/.local/go/bin:$PATH"

# --- Scenario definitions -------------------------------------------------
declare -A SCENARIO_TARGET SCENARIO_PROMPT SCENARIO_CHECK SCENARIO_RUNS
# 1: TypeScript (hono) — response cache middleware
SCENARIO_TARGET[1]="hono"
SCENARIO_PROMPT[1]="$SCRIPT_DIR/prompts/01-response-cache.hono.md"
SCENARIO_CHECK[1]="$SCRIPT_DIR/quality/check-01.sh"
# 2: Lua (bt-lua) — parallel-node crash fix
SCENARIO_TARGET[2]="bt-lua"
SCENARIO_PROMPT[2]="$SCRIPT_DIR/prompts/02-parallel-bug.bt-lua.md"
SCENARIO_CHECK[2]="$SCRIPT_DIR/quality/check-02.sh"
# 3: Python (cachetools) — eviction callback
SCENARIO_TARGET[3]="python"
SCENARIO_PROMPT[3]="$SCRIPT_DIR/prompts/03-eviction-callback.python.md"
SCENARIO_CHECK[3]="$SCRIPT_DIR/quality/check-03.sh"
# 4: Go (gofrs/uuid) — Compare + Sort
SCENARIO_TARGET[4]="go"
SCENARIO_PROMPT[4]="$SCRIPT_DIR/prompts/04-compare-sort.go.md"
SCENARIO_CHECK[4]="$SCRIPT_DIR/quality/check-04.sh"
# 5: TypeScript (full hono) — real bug: c.json() rejects Date (hono #1800/#1806)
#    Large multi-module codebase; fix-light, exploration-heavy. The value
#    dimension: where structural blocks (exports/arch/tree) can earn their keep,
#    which the small-repo floor (s1-s4) structurally can't reward.
SCENARIO_TARGET[5]="hono-full"
SCENARIO_PROMPT[5]="$SCRIPT_DIR/prompts/05-json-dates.hono-full.md"
SCENARIO_CHECK[5]="$SCRIPT_DIR/quality/check-05.sh"

for s in 1 2 3 4 5; do SCENARIO_RUNS[$s]=$RUNS; done

IFS=',' read -ra SCEN <<< "$SCENARIOS"

# --- Results file ---------------------------------------------------------
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"
if [ -n "${RESUME_FILE:-}" ]; then
  RESULTS_FILE="$RESUME_FILE"
else
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  RESULTS_FILE="$RESULTS_DIR/run-${TIMESTAMP}.jsonl"
  echo "{\"type\":\"meta\",\"timestamp\":\"$TIMESTAMP\",\"model\":\"$MODEL\",\"runs_per_cell\":$RUNS,\"conditions\":[\"with\",\"passive\",\"static\"]}" > "$RESULTS_FILE"
fi

log() { echo "[$(date +%H:%M:%S)] $*"; }

# Stop any PipeMD daemon running in THIS worktree's repo root — it would
# interfere with bench worktrees. (The main experimental checkout on another
# branch is left untouched: its daemon lives under a different $REPO_ROOT.)
if [ -f "$REPO_ROOT/.pipemd/.daemon.pid" ]; then
  log "Stopping $REPO_ROOT daemon (bench controls pmd per worktree)..."
  (cd "$REPO_ROOT" && pmd stop) 2>/dev/null || true
fi

# --- Per-ecosystem dependency install -------------------------------------
install_deps() {
  local dir="$1" target="$2"
  case "$target" in
    hono|hono-full)
      (cd "$dir" && bun install --silent 2>/dev/null) \
        || (cd "$dir" && npm install --silent 2>/dev/null) \
        || (cd "$dir" && pnpm install --silent 2>/dev/null) \
        || log "    WARN: hono dep install failed (gates may report false 0)"
      ;;
    python) : ;;   # cachetools is stdlib-only: tests run via PYTHONPATH=src
    go) (cd "$dir" && go mod download 2>/dev/null) || true ;;
    bt-lua) : ;;
  esac
}

# Force all pipes to legacy/file mode in a worktree's config.yml. Bench requires
# real files (not FIFOs) so context is inspectable and survives cp -r.
force_legacy_mode() {
  local dir="$1"
  local config="$dir/.pipemd/config.yml"
  [ -f "$config" ] || return 0
  node -e "
    const fs = require('fs');
    const YAML = require('$REPO_ROOT/node_modules/yaml');
    const raw = fs.readFileSync('$config', 'utf8');
    const cfg = YAML.parse(raw);
    if (cfg.pipes && Array.isArray(cfg.pipes)) {
      for (const p of cfg.pipes) { p.mode = 'legacy'; }
    }
    fs.writeFileSync('$config', YAML.stringify(cfg));
  " 2>/dev/null || true
}

clean_fifos() {
  local dir="$1"
  for f in AGENTS.md CLAUDE.md AI_CONTEXT.md; do
    local target="$dir/$f"
    if [ -p "$target" ]; then
      rm -f "$target"
    fi
  done
  return 0
}

# Render AGENTS.md once for the passive snapshot, then kill the daemon so the
# file is frozen. Returns seconds waited.
render_passive_snapshot() {
  local dir="$1"
  (cd "$dir" && pmd start) >/dev/null 2>&1 || true
  local waited=0
  while [ "$waited" -lt 90 ]; do
    sleep 1; waited=$((waited + 1))
    [ -f "$dir/AGENTS.md" ] && grep -q 'pmd:' "$dir/AGENTS.md" 2>/dev/null && break
  done
  # Kill the daemon directly: `pmd stop` runs cleanStaleState() which DELETES
  # the rendered AGENTS.md. We want to keep the frozen snapshot.
  local pid
  pid=$(cat "$dir/.pipemd/.daemon.pid" 2>/dev/null || true)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  rm -f "$dir/.pipemd/.daemon.pid" 2>/dev/null || true
  return 0
}

# --- Per-run metrics parser (unchanged, proven) ---------------------------
parse_run_metrics() {
  local ndjson_file="$1"
  local result_file="$2"

  local input_tokens=0 output_tokens=0 tool_calls=0 reads=0 edits=0 writes=0 greps=0 globs=0
  local context_reads=0
  local wall_start="" wall_end=""
  local first_turn_input=0
  declare -A file_edits

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local type
    type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null || echo "")
    case "$type" in
      step_start|text)
        if [ -z "$wall_start" ]; then
          wall_start=$(echo "$line" | jq -r '.timestamp // empty' 2>/dev/null || echo "")
        fi
        ;;
      tool_use)
        tool_calls=$((tool_calls + 1))
        local tool_name
        tool_name=$(echo "$line" | jq -r '.part.tool // .part.name // empty' 2>/dev/null || echo "")
        case "$tool_name" in
          read|file_read) reads=$((reads + 1)) ;;
          edit|file_edit) edits=$((edits + 1)) ;;
          write|file_write) writes=$((writes + 1)) ;;
          grep|search) greps=$((greps + 1)) ;;
          glob|list) globs=$((globs + 1)) ;;
        esac
        local tool_input
        tool_input=$(echo "$line" | jq -r '
          (.part.state.input.filePath // .part.state.input.path // .part.state.input.pattern // .part.state.input.command // empty) // empty
        ' 2>/dev/null || echo "")
        case "$tool_input" in
          *AGENTS.md*|*AI_CONTEXT.md*|*CLAUDE.md*) context_reads=$((context_reads + 1)) ;;
        esac
        # Track rework: count edits/writes per file path
        case "$tool_name" in
          edit|file_edit|write|file_write)
            local edit_file
            edit_file=$(echo "$line" | jq -r '.part.state.input.filePath // .part.state.input.path // .part.state.input.file_path // .part.state.input.absolute_path // empty' 2>/dev/null || echo "")
            if [ -n "$edit_file" ]; then
              file_edits["$edit_file"]=$(( ${file_edits["$edit_file"]:-0} + 1 ))
            fi
            ;;
        esac
        ;;
      step_finish)
        wall_end=$(echo "$line" | jq -r '.timestamp // empty' 2>/dev/null || echo "")
        local part_tokens
        part_tokens=$(echo "$line" | jq -c '
          .part.tokens // {} |
          {
            input: (.input // 0),
            output: (.output // 0),
            cache_read: (.cache_read // .["cache.read"] // 0),
            cache_write: (.cache_write // .["cache.write"] // 0)
          }
        ' 2>/dev/null || echo '{"input":0,"output":0,"cache_read":0,"cache_write":0}')
        if [ "$part_tokens" != "null" ] && [ -n "$part_tokens" ]; then
          local inp out cr cw turn_total
          inp=$(echo "$part_tokens" | jq -r '.input // 0')
          out=$(echo "$part_tokens" | jq -r '.output // 0')
          cr=$(echo "$part_tokens" | jq -r '.cache_read // 0')
          cw=$(echo "$part_tokens" | jq -r '.cache_write // 0')
          turn_total=$((inp + cr + cw))
          # Use last turn's total as input_tokens (peak context, avoids re-counting prefix)
          input_tokens=$turn_total
          output_tokens=$((output_tokens + out))
          if [ "$first_turn_input" -eq 0 ] && [ "$turn_total" -gt 0 ]; then
            first_turn_input=$turn_total
          fi
        fi
        ;;
    esac
  done < "$ndjson_file"

  local wall_ms=0
  if [ -n "$wall_start" ] && [ -n "$wall_end" ]; then
    wall_ms=$(( wall_end - wall_start ))
  fi

  # Rework metric (V14/V15): per-file re-edits. Σ max(0, edits_per_file - 1).
  # A file edited once = 0 rework (first edit is creation). Two edits = 1 rework, etc.
  local rework=0 unique_files_edited=0
  for f in "${!file_edits[@]}"; do
    local count=${file_edits[$f]}
    unique_files_edited=$((unique_files_edited + 1))
    if [ "$count" -gt 1 ]; then
      rework=$((rework + count - 1))
    fi
  done

  jq -n -c \
    --argjson tool_calls "$tool_calls" \
    --argjson reads "$reads" \
    --argjson edits "$edits" \
    --argjson writes "$writes" \
    --argjson greps "$greps" \
    --argjson globs "$globs" \
    --argjson wall_ms "$wall_ms" \
    --argjson context_reads "$context_reads" \
    --argjson input_tokens "$input_tokens" \
    --argjson output_tokens "$output_tokens" \
    --argjson first_turn_input "$first_turn_input" \
    --argjson rework "$rework" \
    --argjson unique_files_edited "$unique_files_edited" \
    '{input_tokens: $input_tokens, output_tokens: $output_tokens, tool_calls: $tool_calls, reads: $reads, edits: $edits, writes: $writes, greps: $greps, globs: $globs, wall_ms: $wall_ms, context_reads: $context_reads, first_turn_input: $first_turn_input, rework: $rework, unique_files_edited: $unique_files_edited}' \
    > "$result_file"
}

# A "hung step" = an LLM request (step_start) with no matching completion
# (step_finish). This is an infrastructure failure (provider hang), not an
# agent-quality failure — the cell is worth one clean retry.
has_hung_step() {
  local ndjson="$1"
  [ -f "$ndjson" ] || return 1
  local starts finishes
  starts=$(jq -c 'select(.type=="step_start")' "$ndjson" 2>/dev/null | wc -l)
  finishes=$(jq -c 'select(.type=="step_finish")' "$ndjson" 2>/dev/null | wc -l)
  [ "$starts" -gt "$finishes" ]
}

# --- Run one cell ---------------------------------------------------------
run_cell() {
  local scenario="$1" condition="$2" run_idx="$3" work_dir="$4" prompt_file="$5" clean_base="${6:-}"
  local retry_count="${RETRY_COUNT:-0}"

  local label="s${scenario}-${condition}-r${run_idx}"
  local ndjson_file="$RESULTS_DIR/${label}.ndjson"
  local metrics_file="$RESULTS_DIR/${label}.metrics.json"

  log "  Run $run_idx: $label"

  if [ "$DRY_RUN" = true ]; then
    echo "{\"scenario\":$scenario,\"condition\":\"$condition\",\"run\":$run_idx,\"quality\":0,\"metrics\":{}}" >> "$RESULTS_FILE"
    return
  fi

  local prompt
  prompt=$(cat "$prompt_file")
  local render_failed=false

  if [ "$condition" = "with" ]; then
    if [ -f "$work_dir/.pipemd/config.yml" ]; then
      rm -f "$work_dir/.pipemd/.daemon.pid" "$work_dir/.pipemd/daemon.log" 2>/dev/null || true
      rm -f "$work_dir/AGENTS.md" "$work_dir/CLAUDE.md" "$work_dir/AI_CONTEXT.md" 2>/dev/null || true
      log "    Starting daemon in $(basename "$work_dir")"
      (cd "$work_dir" && pmd start) >/dev/null 2>&1 || true
      local waited=0
      while [ "$waited" -lt 60 ]; do
        sleep 1; waited=$((waited + 1))
        [ -f "$work_dir/AGENTS.md" ] && grep -q 'pmd:' "$work_dir/AGENTS.md" 2>/dev/null && break
      done
      if [ -f "$work_dir/AGENTS.md" ] && grep -q 'pmd:' "$work_dir/AGENTS.md" 2>/dev/null; then
        log "    Context OK: $(grep -c 'pmd:' "$work_dir/AGENTS.md") pmd blocks, $(wc -c < "$work_dir/AGENTS.md") bytes (${waited}s)"
      else
        log "    VOID: AGENTS.md render failed after ${waited}s — excluding cell"
        render_failed=true
      fi
    fi
  elif [ "$condition" = "passive" ]; then
    rm -f "$work_dir/.pipemd/.daemon.pid" 2>/dev/null || true
    if [ -f "$work_dir/AGENTS.md" ] && grep -q 'pmd:' "$work_dir/AGENTS.md" 2>/dev/null; then
      log "    Passive context OK: $(grep -c 'pmd:' "$work_dir/AGENTS.md") blocks, $(wc -c < "$work_dir/AGENTS.md") bytes (frozen snapshot)"
    else
      log "    VOID: passive snapshot missing — excluding cell"
      render_failed=true
    fi
  elif [ "$condition" = "static" ]; then
    if [ -f "$work_dir/AGENTS.md" ]; then
      log "    Static context OK: $(wc -l < "$work_dir/AGENTS.md")-line AGENTS.md, $(wc -c < "$work_dir/AGENTS.md") bytes (no pmd blocks)"
    else
      log "    VOID: static AGENTS.md missing — excluding cell"
      render_failed=true
    fi
  fi

  if [ "$render_failed" = true ]; then
    echo "{\"scenario\":\"$scenario\",\"condition\":\"$condition\",\"run\":$run_idx,\"quality\":-1,\"metrics\":{\"void\":true,\"reason\":\"render_timeout\",\"wall_ms\":0}}" >> "$RESULTS_FILE"
    [ "$condition" = "with" ] && (cd "$work_dir" && pmd stop) >/dev/null 2>&1 || true
    return 1
  fi

  # Run opencode (agent confined to $work_dir via --dir). We ALSO cd into the
  # work_dir because the opencode server plugin resolves the project via
  # process.cwd() (PLUG-008): without the cd it reads the launcher's project
  # and delivers zero injections.
  # NOTE: opencode run has no --temperature flag (only --variant for reasoning
  # effort), so determinism (BENCH-009) is not controllable from here.
  local start_ms end_ms elapsed_ms
  start_ms=$(date +%s%3N)
  timeout "${OPENCODE_TIMEOUT:-600}" bash -c 'cd "$1" && opencode run --format json --model "$2" --dir "$1" "$3"' \
    _ "$work_dir" "$MODEL" "$prompt" \
    > "$ndjson_file" 2>/dev/null || true
  end_ms=$(date +%s%3N)
  elapsed_ms=$(( end_ms - start_ms ))

  # Retrospective (only meaningful where pipemd context was consumed)
  local retro_path=""
  if [ "$condition" = "with" ] || [ "$condition" = "passive" ]; then
    local retro_ndjson="$RESULTS_DIR/${label}.retro.ndjson"
    log "    Retrospective..."
    log "    Retrospective..."
    timeout "${OPENCODE_TIMEOUT:-300}" bash -c 'cd "$1" && opencode run --continue --format json --model "$2" --dir "$1" "$3"' \
      _ "$work_dir" "$MODEL" "$RETROSPECTIVE_PROMPT" \
      > "$retro_ndjson" 2>/dev/null || true
    local retro_dir="$RESULTS_DIR/retrospectives"
    mkdir -p "$retro_dir"
    retro_path="${retro_dir}/${label}.md"
    jq -r 'select(.type == "text") | .part.text // empty' "$retro_ndjson" 2>/dev/null \
      | sed '/^$/d' > "$retro_path"
    if [ ! -s "$retro_path" ]; then
      rm -f "$retro_path"; retro_path=""
    fi
  fi

  # Stop daemon if we started it; capture injection stats
  local injections_delivered=0 dedup_hits=0
  if [ "$condition" = "with" ]; then
    local tui_stats="$work_dir/.pipemd/.tui-stats.json"
    local inject_stats="$work_dir/.pipemd/.inject-stats.json"
    # Prefer .inject-stats.json (daemon-side, always written); fall back to TUI stats.
    if [ -f "$inject_stats" ]; then
      injections_delivered=$(jq -r '.delivered // 0' "$inject_stats" 2>/dev/null || echo "0")
      dedup_hits=$(jq -r '.dedup // 0' "$inject_stats" 2>/dev/null || echo "0")
    elif [ -f "$tui_stats" ]; then
      injections_delivered=$(jq -r '.injectionsDelivered // 0' "$tui_stats" 2>/dev/null || echo "0")
      dedup_hits=$(jq -r '.dedupHits // 0' "$tui_stats" 2>/dev/null || echo "0")
    fi
    log "    Injection stats: delivered=$injections_delivered deduped=$dedup_hits (src=$([ -f "$inject_stats" ] && echo inject-stats || echo tui-stats))"
    (cd "$work_dir" && pmd stop) >/dev/null 2>&1 || true
    pmd crew clean --force >/dev/null 2>&1 || true
  fi

  parse_run_metrics "$ndjson_file" "$metrics_file"

  # VOID detection: infrastructure failure, not agent failure
  local is_void=false void_reason="" parsed_tool_calls=0
  if [ -f "$metrics_file" ]; then
    parsed_tool_calls=$(jq -r '.tool_calls // 0' "$metrics_file" 2>/dev/null || echo "0")
  fi
  if [ "$parsed_tool_calls" -eq 0 ] || [ "$elapsed_ms" -ge $(( (${OPENCODE_TIMEOUT:-600} - 1) * 1000 )) ]; then
    is_void=true; void_reason="agent_timeout"
    log "    VOID: timeout (tool_calls=$parsed_tool_calls, wall_ms=$elapsed_ms)"
  fi

  if [ "$is_void" = true ]; then
    # One clean retry on a hung LLM request (step_start with no step_finish).
    # The agent did real work up to the hang; reset to a clean work_dir so the
    # retry isn't biased by the partial edits of the killed attempt.
    if [ "$void_reason" = "agent_timeout" ] && [ "$retry_count" -lt 1 ] && [ -n "$clean_base" ] && has_hung_step "$ndjson_file"; then
      log "    Retry: hung LLM request (step_start without step_finish) — resetting work_dir, re-running cell"
      [ "$condition" = "with" ] && (cd "$work_dir" && pmd stop) >/dev/null 2>&1 || true
      rm -rf "$work_dir"
      cp -r "$clean_base" "$work_dir"
      RETRY_COUNT=$((retry_count + 1)) run_cell "$scenario" "$condition" "$run_idx" "$work_dir" "$prompt_file" "$clean_base"
      return $?
    fi
    local void_metrics void_record
    void_metrics=$(cat "$metrics_file" 2>/dev/null || echo '{}')
    void_record=$(jq -n -c \
      --argjson scenario "$scenario" --arg condition "$condition" --argjson run "$run_idx" \
      --argjson metrics "$void_metrics" --argjson wall "$elapsed_ms" \
      '{scenario:$scenario, condition:$condition, run:$run, quality:-1, metrics:($metrics+{void:true,reason:"agent_timeout",wall_ms:$wall}), retrospective:null}' 2>/dev/null) \
      || void_record='{"scenario":'"$scenario"',"condition":"'"$condition"'","run":'"$run_idx"',"quality":-1,"metrics":{"void":true,"reason":"agent_timeout","wall_ms":0},"retrospective":null}'
    echo "$void_record" >> "$RESULTS_FILE"
    [ "$condition" = "with" ] && (cd "$work_dir" && pmd stop) >/dev/null 2>&1 || true
    return 1
  fi

  # Override wall_ms with external measurement
  if [ -f "$metrics_file" ]; then
    local tmp_metrics
    tmp_metrics=$(jq --argjson wall "$elapsed_ms" '.wall_ms = $wall' "$metrics_file" 2>/dev/null) || true
    [ -n "$tmp_metrics" ] && echo "$tmp_metrics" > "$metrics_file"
  fi

  # Quality gate — run INSIDE the worktree so relative paths resolve
  local quality=0 check_script="${SCENARIO_CHECK[$scenario]}"
  if [ -f "$check_script" ]; then
    quality=$(cd "$work_dir" && bash "$check_script" 2>/dev/null || echo "0")
  fi

  local metrics_json
  metrics_json=$(cat "$metrics_file" 2>/dev/null || true)
  if ! (echo "$metrics_json" | jq empty 2>/dev/null); then
    metrics_json='{"input_tokens":0,"output_tokens":0,"tool_calls":0,"reads":0,"edits":0,"writes":0,"greps":0,"globs":0,"wall_ms":0,"context_reads":0,"rework":0,"unique_files_edited":0}'
  fi
  if [ "$condition" = "with" ]; then
    metrics_json=$(echo "$metrics_json" | jq --argjson inj "$injections_delivered" --argjson dedup "$dedup_hits" \
      '.injections_delivered=$inj | .dedup_hits=$dedup' 2>/dev/null || echo "$metrics_json")
  fi

  local record
  record=$(jq -n -c \
    --argjson scenario "$scenario" --arg condition "$condition" --argjson run "$run_idx" \
    --argjson quality "$quality" --argjson metrics "$metrics_json" --arg retro "${retro_path:-}" \
    '{scenario:$scenario, condition:$condition, run:$run, quality:$quality, metrics:$metrics, retrospective:(if $retro=="" then null else $retro end)}' 2>/dev/null) \
    || record='{"scenario":'"$scenario"',"condition":"'"$condition"'","run":'"$run_idx"',"quality":'"$quality"',"metrics":{"tool_calls":0},"retrospective":null}'
  echo "$record" >> "$RESULTS_FILE"
  log "    Quality: $quality, Tool calls: $(jq -r '.tool_calls // "?"' <<< "$metrics_json" 2>/dev/null || echo "?")"
}

# --- Setup worktree for a condition ---------------------------------------
setup_worktree() {
  local target="$1" worktree_dir="$2" condition="$3" base_repo="$4"

  rm -rf "$worktree_dir" 2>/dev/null || true
  cp -r "$base_repo" "$worktree_dir"
  # Drop the upstream clone's git history; bench needs a fresh repo so quality
  # gates that diff against "baseline" only see the agent's edits.
  rm -rf "$worktree_dir/.git" "$worktree_dir/node_modules" 2>/dev/null || true
  (cd "$worktree_dir" && git init -q && git add -A && git commit -qm "baseline" 2>/dev/null || true)

  if [ "$condition" = "static" ]; then
    # STATIC: realistic hand-written-style AGENTS.md, no PipeMD whatsoever.
    rm -rf "$worktree_dir/.pipemd" "$worktree_dir/.opencode" 2>/dev/null || true
    local static_src="$SCRIPT_DIR/baselines/static-agents/${target}.AGENTS.md"
    if [ -f "$static_src" ]; then
      cp "$static_src" "$worktree_dir/AGENTS.md"
      log "    Static AGENTS.md: $(wc -l < "$static_src") lines"
    else
      log "    WARNING: $static_src missing — STATIC cell will be void"
    fi
  elif [ "$condition" = "passive" ]; then
    # PASSIVE: full pmd init + one render, then freeze (daemon killed).
    (cd "$worktree_dir" && pmd init --yes) >/dev/null 2>&1 \
      || log "    WARN: pmd init failed (passive snapshot may be empty)"
    force_legacy_mode "$worktree_dir"
    clean_fifos "$worktree_dir"
    render_passive_snapshot "$worktree_dir"
    if [ -f "$worktree_dir/AGENTS.md" ] && grep -q 'pmd:' "$worktree_dir/AGENTS.md" 2>/dev/null; then
      log "    Passive snapshot rendered"
    else
      log "    WARNING: passive snapshot failed to render"
    fi
  else
    # WITH: pmd init + plugin (active injection). Daemon starts per-run in run_cell.
    (cd "$worktree_dir" && pmd init --yes) >/dev/null 2>&1 \
      || log "    WARN: pmd init failed (with arm may degrade)"
    force_legacy_mode "$worktree_dir"
    clean_fifos "$worktree_dir"
  fi

  install_deps "$worktree_dir" "$target"

  # Re-commit so gate diffs (git status) reflect only the agent's edits.
  (cd "$worktree_dir" && git add -A && git commit -qm "pmd baseline" 2>/dev/null || true)

  # Auto-approve permissions for the agent inside the worktree.
  cat > "$worktree_dir/opencode.json" << 'PERM_EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "read": "allow", "edit": "allow", "write": "allow",
    "bash": "allow", "glob": "allow", "grep": "allow", "list": "allow", "task": "allow"
  }
}
PERM_EOF
}

# --- Generate static baselines if missing (one-shot, glm-5.1, cached) -----
ensure_static_baselines() {
  [ "$NO_GEN" = true ] && return 0
  local gen="$SCRIPT_DIR/gen-static-baseline.sh"
  [ -f "$gen" ] || { log "gen-static-baseline.sh not found; skipping static baseline gen"; return 0; }
  for s in "${SCEN[@]}"; do
    local t="${SCENARIO_TARGET[$s]}"
    local out="$SCRIPT_DIR/baselines/static-agents/${t}.AGENTS.md"
    if [ -f "$out" ]; then
      log "Static baseline for $t: cached ($out)"
    else
      log "Generating static baseline for $t ($GEN_MODEL)..."
      bash "$gen" "$t" "$GEN_MODEL" || log "  WARN: gen failed for $t"
    fi
  done
}

# ==========================================================================
log "=== PipeMD Agent A/B Benchmark v2 (3-condition, multi-ecosystem) ==="
log "Model: $MODEL  (gen: $GEN_MODEL)  Runs/cell: $RUNS  Scenarios: $SCENARIOS"
log "Conditions: ${CONDITIONS}"
log ""

ensure_static_baselines

for s in "${SCEN[@]}"; do
  target="${SCENARIO_TARGET[$s]}"
  base="$SCRIPT_DIR/repos/${target}-clean"
  log "Scenario $s ($target): $(basename "${SCENARIO_PROMPT[$s]}")"

  if [ ! -d "$base" ]; then
    log "  SKIP: $base not found"
    continue
  fi

  IFS=',' read -ra COND_ARR <<< "$CONDITIONS"
  for condition in "${COND_ARR[@]}"; do
    log "  Condition: $condition"
    worktree_base="$RESULTS_DIR/${target}-${condition}"

    setup_worktree "$target" "$worktree_base" "$condition" "$base"

    cell_runs=${SCENARIO_RUNS[$s]:-$RUNS}
    for (( r=1; r<=cell_runs; r++ )); do
      # Resume: skip runs already present (quoted pattern — fixes old glob bug).
      if [ -f "$RESULTS_FILE" ] && grep -q "\"condition\":\"$condition\".*\"run\":$r[^0-9]" "$RESULTS_FILE" 2>/dev/null; then
        # Also ensure the scenario matches (jsonl is flat across scenarios)
        if grep -q "\"scenario\":$s,.*\"condition\":\"$condition\".*\"run\":$r[^0-9]" "$RESULTS_FILE" 2>/dev/null; then
          log "  Run $r/$cell_runs: s${s}-${condition}-r${r} (skip — recorded)"
          continue
        fi
      fi
      run_dir="$RESULTS_DIR/run-s${s}-${condition}-r${r}"
      rm -rf "$run_dir" 2>/dev/null || true
      cp -r "$worktree_base" "$run_dir"

      run_cell "$s" "$condition" "$r" "$run_dir" "${SCENARIO_PROMPT[$s]}" "$worktree_base" || true

      rm -rf "$run_dir" 2>/dev/null || true
    done
    # Free the base worktree between conditions.
    rm -rf "$worktree_base" 2>/dev/null || true
  done
done

log ""
log "=== Results ==="
log "Raw data: $RESULTS_FILE"

# --- Summary (node) -------------------------------------------------------
log "Generating summary..."
node -e "
const fs = require('fs');
const lines = fs.readFileSync('$RESULTS_FILE', 'utf8').split('\n').filter(l => l.trim());
const runs = lines.slice(1).map(l => JSON.parse(l));
const voidRuns = runs.filter(r => r.quality === -1);
const groups = {};
for (const r of runs) { if (r.quality === -1) continue; const k = r.scenario + '-' + r.condition; (groups[k] ||= []).push(r); }
const scenarios = [...new Set(runs.filter(r => r.quality !== -1).map(r => r.scenario))].sort();
if (voidRuns.length) console.log('VOID runs excluded: ' + voidRuns.length + ' (' + voidRuns.map(v => 's'+v.scenario+'-'+v.condition+'-r'+v.run).join(', ') + ')');
const OUTPUT_WEIGHT = 4;
const pct = (a, b) => (!b ? '-' : ((a - b) / b * 100).toFixed(0).replace(/^(-)?/, (m)=>m||'+') + '%');
const med = (arr) => { if (!arr || !arr.length) return null; const s = [...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };
const COND = { F: 'with', P: 'passive', S: 'static' };
for (const s of scenarios) {
  const f = groups[s+'-with']||[], p = groups[s+'-passive']||[], n = groups[s+'-static']||[];
  const st = (d) => !d.length ? null : { tc: med(d.map(x=>x.metrics.tool_calls)), r: med(d.map(x=>x.metrics.reads)),
    it: med(d.map(x=>x.metrics.input_tokens)), ot: med(d.map(x=>x.metrics.output_tokens)),
    blend: med(d.map(x=>(x.metrics.input_tokens||0)+OUTPUT_WEIGHT*(x.metrics.output_tokens||0))),
    w: med(d.map(x=>x.metrics.wall_ms)), inj: med(d.map(x=>x.metrics.injections_delivered||0)),
    q: med(d.map(x=>x.quality)) };
  const sf=st(f), sp=st(p), sn=st(n);
  const row = (lbl, fn) => console.log('  ' + lbl.padEnd(14) + [sf,sp,sn].map(x => (x ? String(fn(x)) : '-').padStart(14)).join(''));
  const q = (sf?sf.q:'?')+'/'+(sp?sp.q:'?')+'/'+(sn?sn.q:'?');
  console.log('\\n=== Scenario ' + s + ' (N='+f.length+'/'+p.length+'/'+n.length+', Q='+q+') ===');
  console.log('  ' + ''.padEnd(14) + ['WITH','PASSIVE','STATIC'].map(s=>s.padStart(14)).join(''));
  row('tool_calls', x=>x.tc); row('reads', x=>x.r); row('input_tokens', x=>x.it);
  row('output_tokens', x=>x.ot); row('blended_cost', x=>x.blend); row('wall_ms', x=>x.w); row('injections', x=>x.inj);
  if (sf && sn) console.log('  Δ WITH vs STATIC:  reads '+pct(sf.r,sn.r)+', tokens '+pct(sf.it,sn.it)+', wall '+pct(sf.w,sn.w)+', output '+pct(sf.ot,sn.ot));
  if (sp && sn) console.log('  Δ PASSIVE vs STATIC: reads '+pct(sp.r,sn.r)+', tokens '+pct(sp.it,sn.it)+', wall '+pct(sp.w,sn.w));
  if (sf && sp) console.log('  Δ WITH vs PASSIVE:  reads '+pct(sf.r,sp.r)+', tokens '+pct(sf.it,sp.it)+', wall '+pct(sf.w,sp.w));
}
console.log('\\nblended_cost = input + '+OUTPUT_WEIGHT+'x output | STATIC = realistic control (no pmd)');
" 2>/dev/null || log "  (summary failed)"

log "Generating HTML report..."
bash "$SCRIPT_DIR/report-html.sh" "$RESULTS_FILE" 2>/dev/null || log "  (report generation failed)"

log "Done."
