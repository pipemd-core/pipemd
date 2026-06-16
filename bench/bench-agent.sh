#!/usr/bin/env bash
# bench-agent.sh — PipeMD Agent A/B Benchmark Runner
#
# Runs N scenarios × 3 conditions (full/passive/none) × N repetitions.
#   full    = PipeMD daemon + plugin + live injection
#   passive = rendered AGENTS.md snapshot, no daemon, no plugin
#   none    = no PipeMD at all
# Uses git worktrees for per-run isolation.
# Parses OpenCode NDJSON output for tokens, tool calls, and wall time.
#
# Usage: bash bench/bench-agent.sh [--runs N] [--model MODEL] [--scenarios 1,2,3,4]
#
# Prerequisites:
#   - opencode in PATH
#   - bun installed (for Hono)
#   - pnpm installed (for PipeMD)
#   - PipeMD daemon NOT running (script controls it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
RUNS=3
MODEL="zai-coding-plan/glm-5.1"
SCENARIOS="1,2,3,4"
DRY_RUN=false
REPORT_ONLY=""

RETROSPECTIVE_PROMPT="You just completed a task using PipeMD context (the AGENTS.md file with <!-- pmd: --> blocks). Give honest, concise feedback in a numbered list.

1. Which pmd: blocks were actually useful? Which did you ignore?
2. Did any block return stale, empty, or misleading data?
3. What did you need that no block provided?
4. Were there moments you explored the codebase manually for something that should have been in context?
5. Any block that felt like wasted tokens?

Be brutally honest — flattery is useless. One sentence per point max."

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --scenarios) SCENARIOS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --report)
      if [ -z "${2:-}" ]; then echo "Usage: --report <results.jsonl>"; exit 1; fi
      REPORT_ONLY="$2"; shift 2 ;;
    --resume)
      if [ -z "${2:-}" ]; then echo "Usage: --resume <results.jsonl>"; exit 1; fi
      RESUME_FILE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: bash bench/bench-agent.sh [--runs N] [--model MODEL] [--scenarios 1,2,3] [--dry-run]"
      echo "       bash bench/bench-agent.sh --resume <results.jsonl>"
      echo "       bash bench/bench-agent.sh --report <results.jsonl>"
      exit 0 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Report-only mode: regenerate HTML from an existing JSONL
if [ -n "$REPORT_ONLY" ]; then
  bash "$SCRIPT_DIR/report-html.sh" "$REPORT_ONLY"
  exit $?
fi

# Scenario definitions
declare -A SCENARIO_TARGET SCENARIO_PROMPT SCENARIO_PROJECT SCENARIO_REPO SCENARIO_CHECK
SCENARIO_TARGET[1]="pipemd"
SCENARIO_TARGET[2]="hono"
SCENARIO_TARGET[3]="hono"
SCENARIO_TARGET[4]="bt-lua"

SCENARIO_PROMPT[1]="$SCRIPT_DIR/prompts/01-doctor.pipemd.md"
SCENARIO_PROMPT[2]="$SCRIPT_DIR/prompts/02-middleware-timing.hono.md"
SCENARIO_PROMPT[3]="$SCRIPT_DIR/prompts/03-error-handler.hono.md"
SCENARIO_PROMPT[4]="$SCRIPT_DIR/prompts/04-parallel-bug.bt-lua.md"

SCENARIO_CHECK[1]="$SCRIPT_DIR/quality/check-01.sh"
SCENARIO_CHECK[2]="$SCRIPT_DIR/quality/check-02.sh"
SCENARIO_CHECK[3]="$SCRIPT_DIR/quality/check-03.sh"
SCENARIO_CHECK[4]="$SCRIPT_DIR/quality/check-04.sh"

# Per-scenario run overrides: long/medium = 2, short = 3
declare -A SCENARIO_RUNS
SCENARIO_RUNS[1]=3   # long: improve pmd doctor
SCENARIO_RUNS[2]=3   # short: hono middleware
SCENARIO_RUNS[3]=3   # medium: hono error handler
SCENARIO_RUNS[4]=3   # short: bt-lua bug fix

# Parse scenario list
IFS=',' read -ra SCEN <<< "$SCENARIOS"

# Results file
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"
if [ -n "${RESUME_FILE:-}" ]; then
  RESULTS_FILE="$RESUME_FILE"
else
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  RESULTS_FILE="$RESULTS_DIR/run-${TIMESTAMP}.jsonl"
  echo "{\"type\":\"meta\",\"timestamp\":\"$TIMESTAMP\",\"model\":\"$MODEL\",\"runs_per_cell\":$RUNS}" > "$RESULTS_FILE"
fi

log() { echo "[$(date +%H:%M:%S)] $*"; }

# Stop any running PipeMD daemon in the main repo — it would interfere
# with bench worktrees (nested subdirectories, stale PID files, chokidar overlap)
if [ -f "$REPO_ROOT/.pipemd/.daemon.pid" ]; then
  log "Stopping main repo daemon..."
  (cd "$REPO_ROOT" && pmd stop) 2>/dev/null || true
fi

# Parse NDJSON from opencode run --format json
parse_run_metrics() {
  local ndjson_file="$1"
  local result_file="$2"

  local input_tokens=0 output_tokens=0 tool_calls=0 reads=0 edits=0 writes=0 greps=0 globs=0
  local context_reads=0
  local wall_start="" wall_end=""
  local first_turn_input=0

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null || echo "")

    case "$type" in
      step_start|text)
        if [ -z "$wall_start" ]; then
          wall_start=$(echo "$line" | jq -r '.timestamp // empty' 2>/dev/null || echo "")
        fi
        ;;
      tool_use)
        tool_calls=$((tool_calls + 1))
        local tool_name=$(echo "$line" | jq -r '.part.tool // .part.name // empty' 2>/dev/null || echo "")
        case "$tool_name" in
          read|file_read) reads=$((reads + 1)) ;;
          edit|file_edit) edits=$((edits + 1)) ;;
          write|file_write) writes=$((writes + 1)) ;;
          grep|search) greps=$((greps + 1)) ;;
          glob|list) globs=$((globs + 1)) ;;
        esac
        # Track context file reads (AGENTS.md, AI_CONTEXT.md, CLAUDE.md)
        local tool_input=$(echo "$line" | jq -r '
          (.part.state.input.filePath // .part.state.input.path // .part.state.input.pattern // .part.state.input.command // empty) // empty
        ' 2>/dev/null || echo "")
        case "$tool_input" in
          *AGENTS.md*|*AI_CONTEXT.md*|*CLAUDE.md*) context_reads=$((context_reads + 1)) ;;
        esac
        ;;
      step_finish)
        wall_end=$(echo "$line" | jq -r '.timestamp // empty' 2>/dev/null || echo "")
        local part_tokens=$(echo "$line" | jq -c '
          .part.tokens // {} |
          {
            input: (.input // 0),
            output: (.output // 0),
            cache_read: (.cache_read // .["cache.read"] // 0),
            cache_write: (.cache_write // .["cache.write"] // 0)
          }
        ' 2>/dev/null || echo '{"input":0,"output":0,"cache_read":0,"cache_write":0}')
        if [ "$part_tokens" != "null" ] && [ "$part_tokens" != "" ]; then
          local inp=$(echo "$part_tokens" | jq -r '.input // 0')
          local out=$(echo "$part_tokens" | jq -r '.output // 0')
          local cr=$(echo "$part_tokens" | jq -r '.cache_read // 0')
          local cw=$(echo "$part_tokens" | jq -r '.cache_write // 0')
          local turn_total=$((inp + cr + cw))
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

  # Wall time
  local wall_ms=0
  if [ -n "$wall_start" ] && [ -n "$wall_end" ]; then
    wall_ms=$(( (wall_end - wall_start) ))
  fi

  # Write result
  jq -n -c \
    --arg input "$input_tokens" \
    --arg output "$output_tokens" \
    --argjson tool_calls "$tool_calls" \
    --argjson reads "$reads" \
    --argjson edits "$edits" \
    --argjson writes "$writes" \
    --argjson greps "$greps" \
    --argjson globs "$globs" \
    --argjson wall_ms "$wall_ms" \
    --argjson context_reads "$context_reads" \
    --argjson first_turn_input "$first_turn_input" \
    '{input_tokens: ($input|tonumber), output_tokens: ($output|tonumber), tool_calls: $tool_calls, reads: $reads, edits: $edits, writes: $writes, greps: $greps, globs: $globs, wall_ms: $wall_ms, context_reads: $context_reads, first_turn_input: $first_turn_input}' \
    > "$result_file"
}

# Run a single cell
run_cell() {
  local scenario="$1"
  local condition="$2"  # "with" or "without"
  local run_idx="$3"
  local worktree="$4"
  local prompt_file="$5"
  local project_dir="$6"

  local label="s${scenario}-${condition}-r${run_idx}"
  local ndjson_file="$RESULTS_DIR/${label}.ndjson"
  local metrics_file="$RESULTS_DIR/${label}.metrics.json"

  log "  Run $run_idx/[$RUNS]: $label"

  if [ "$DRY_RUN" = true ]; then
    echo "{\"scenario\":$scenario,\"condition\":\"$condition\",\"run\":$run_idx,\"quality\":0,\"metrics\":{}}" >> "$RESULTS_FILE"
    return
  fi

  # Read prompt
  local prompt
  prompt=$(cat "$prompt_file")

  # Determine work dir
  local work_dir="$worktree"

  local render_failed=false

  if [ "$condition" = "with" ]; then
    if [ -f "$work_dir/.pipemd/config.yml" ]; then
      # Clean stale state from cp -r (PID file, FIFOs, old daemon log)
      rm -f "$work_dir/.pipemd/.daemon.pid" "$work_dir/.pipemd/daemon.log" 2>/dev/null || true
      rm -f "$work_dir/AGENTS.md" "$work_dir/CLAUDE.md" "$work_dir/AI_CONTEXT.md" 2>/dev/null || true
      log "    Starting daemon in $work_dir"
      (cd "$work_dir" && pmd start) 2>/dev/null || true
      local waited=0
      while [ $waited -lt 60 ]; do
        sleep 1
        waited=$((waited + 1))
        if [ -f "$work_dir/AGENTS.md" ] && grep -q 'pmd:' "$work_dir/AGENTS.md" 2>/dev/null; then
          break
        fi
      done
      local ctx_file="$work_dir/AGENTS.md"
      if [ -f "$ctx_file" ] && grep -q 'pmd:' "$ctx_file" 2>/dev/null; then
        local block_count
        block_count=$(grep -c 'pmd:' "$ctx_file" 2>/dev/null || echo "0")
        log "    Context OK: $block_count pmd: blocks in $(basename "$ctx_file") (${waited}s)"
      else
        log "    VOID: AGENTS.md render failed after ${waited}s — excluding cell"
        render_failed=true
      fi
    fi
  elif [ "$condition" = "passive" ]; then
    # Passive: AGENTS.md already rendered as snapshot during setup.
    # Just verify it exists — no daemon, no plugin.
    rm -f "$work_dir/.pipemd/.daemon.pid" "$work_dir/.pipemd/daemon.log" 2>/dev/null || true
    if [ -f "$work_dir/AGENTS.md" ] && grep -q 'pmd:' "$work_dir/AGENTS.md" 2>/dev/null; then
      local block_count
      block_count=$(grep -c 'pmd:' "$work_dir/AGENTS.md" 2>/dev/null || echo "0")
      log "    Passive context OK: $block_count pmd: blocks (frozen snapshot)"
    else
      log "    VOID: AGENTS.md snapshot missing — excluding cell"
      render_failed=true
    fi
  fi

  if [ "$render_failed" = true ]; then
    echo "{\"scenario\":\"$scenario\",\"condition\":\"$condition\",\"run\":$run_idx,\"quality\":-1,\"metrics\":{\"void\":true,\"reason\":\"render_timeout\",\"wall_ms\":0}}" \
      >> "$RESULTS_FILE"
    if [ "$condition" = "with" ]; then
      (cd "$work_dir" && pmd stop) 2>/dev/null || true
    fi
    return 1
  fi

  # Run opencode
  local start_ms
  start_ms=$(date +%s%3N)

  timeout "${OPENCODE_TIMEOUT:-600}" opencode run --format json --model "$MODEL" --dir "$work_dir" "$prompt" \
    > "$ndjson_file" 2>/dev/null || true

  local end_ms
  end_ms=$(date +%s%3N)
  local elapsed_ms=$(( end_ms - start_ms ))

  # Retrospective: ask the agent which blocks helped (with + passive, context was consumed)
  local retro_path=""
  if [ "$condition" = "with" ] || [ "$condition" = "passive" ]; then
    local retro_ndjson="$RESULTS_DIR/${label}.retro.ndjson"
    log "    Running retrospective follow-up..."
    timeout "${OPENCODE_TIMEOUT:-300}" opencode run --continue --format json --model "$MODEL" --dir "$work_dir" \
      "$RETROSPECTIVE_PROMPT" > "$retro_ndjson" 2>/dev/null || true

    local retro_dir="$RESULTS_DIR/retrospectives"
    mkdir -p "$retro_dir"
    retro_path="${retro_dir}/s${scenario}-${condition}-r${run_idx}.md"
    # Extract text events from retro NDJSON
    jq -r 'select(.type == "text") | .part.text // empty' "$retro_ndjson" 2>/dev/null \
      | sed '/^$/d' > "$retro_path"
    if [ ! -s "$retro_path" ]; then
      rm -f "$retro_path"
      retro_path=""
      log "    Retrospective: (empty response)"
    else
      log "    Retrospective: $(wc -l < "$retro_path") lines captured"
    fi
  fi

  # Stop daemon if we started it
  local injections_delivered=0
  local dedup_hits=0
  if [ "$condition" = "with" ]; then
    # Capture injection stats before stopping daemon
    local tui_stats="$work_dir/.pipemd/.tui-stats.json"
    if [ -f "$tui_stats" ]; then
      injections_delivered=$(jq -r '.injectionsDelivered // 0' "$tui_stats" 2>/dev/null || echo "0")
      dedup_hits=$(jq -r '.dedupHits // 0' "$tui_stats" 2>/dev/null || echo "0")
      log "    Injections delivered: $injections_delivered, dedup hits: $dedup_hits"
    else
      log "    No injection stats found (.tui-stats.json missing)"
    fi
    (cd "$work_dir" && pmd stop) 2>/dev/null || true
    # Clean up stale crew sessions left by opencode run
    pmd crew clean --force 2>/dev/null || true
  fi

  # Parse metrics
  parse_run_metrics "$ndjson_file" "$metrics_file"

  # Detect VOID runs (infrastructure failures, not agent failures)
  local is_void=false
  local void_reason=""
  local parsed_tool_calls=0
  if [ -f "$metrics_file" ]; then
    parsed_tool_calls=$(jq -r '.tool_calls // 0' "$metrics_file" 2>/dev/null || echo "0")
  fi
  if [ "$parsed_tool_calls" -eq 0 ] || [ "$elapsed_ms" -ge $(( (${OPENCODE_TIMEOUT:-600} - 1) * 1000 )) ]; then
    is_void=true
    void_reason="agent_timeout"
    log "    VOID: agent timeout (tool_calls=$parsed_tool_calls, wall_ms=$elapsed_ms)"
  fi

  if [ "$is_void" = true ]; then
    local void_metrics
    void_metrics=$(cat "$metrics_file" 2>/dev/null || echo '{}')
    local void_record
    void_record=$(jq -n -c \
      --argjson scenario "$scenario" \
      --arg condition "$condition" \
      --argjson run "$run_idx" \
      --argjson metrics "$void_metrics" \
      --argjson wall "$elapsed_ms" \
      '{scenario: $scenario, condition: $condition, run: $run_idx, quality: -1, metrics: ($metrics + {void: true, reason: "agent_timeout", wall_ms: $wall}), retrospective: null}' 2>/dev/null) \
      || void_record='{"scenario":'"$scenario"',"condition":"'"$condition"'","run":'"$run_idx"',"quality":-1,"metrics":{"void":true,"reason":"agent_timeout","wall_ms":0},"retrospective":null}'
    echo "$void_record" >> "$RESULTS_FILE"
    if [ "$condition" = "with" ]; then
      (cd "$work_dir" && pmd stop) 2>/dev/null || true
    fi
    return 1
  fi

  # Override wall_ms with external measurement
  if [ -f "$metrics_file" ]; then
    local tmp_metrics
    tmp_metrics=$(jq --argjson wall "$elapsed_ms" '.wall_ms = $wall' "$metrics_file" 2>/dev/null) || true
    if [ -n "$tmp_metrics" ]; then
      echo "$tmp_metrics" > "$metrics_file"
    fi
  fi

  # Quality check — run INSIDE the worktree so relative paths resolve correctly
  local quality=0
  local check_script="${SCENARIO_CHECK[$scenario]}"
  if [ -f "$check_script" ]; then
    quality=$(cd "$work_dir" && bash "$check_script" 2>/dev/null || echo "0")
  fi

  # Record result
  local metrics_json
  metrics_json=$(cat "$metrics_file" 2>/dev/null || true)
  # Validate — if metrics file is missing or invalid, use empty defaults
  if ! (echo "$metrics_json" | jq empty 2>/dev/null); then
    metrics_json='{"input_tokens":0,"output_tokens":0,"tool_calls":0,"reads":0,"edits":0,"writes":0,"greps":0,"globs":0,"wall_ms":0,"context_reads":0}'
  fi
  # Add injection count for WITH runs (always write, even if 0, so we can distinguish "not measured" from "measured 0")
  if [ "$condition" = "with" ]; then
    metrics_json=$(echo "$metrics_json" | jq --argjson inj "$injections_delivered" --argjson dedup "$dedup_hits" '.injections_delivered = $inj | .dedup_hits = $dedup' 2>/dev/null || echo "$metrics_json")
  fi

  local record
  record=$(jq -n -c \
    --argjson scenario "$scenario" \
    --arg condition "$condition" \
    --argjson run "$run_idx" \
    --argjson quality "$quality" \
    --argjson metrics "$metrics_json" \
    --arg retro "${retro_path:-}" \
    '{scenario: $scenario, condition: $condition, run: $run, quality: $quality, metrics: $metrics, retrospective: (if $retro == "" then null else $retro end)}' 2>/dev/null) \
    || record='{"scenario":'"$scenario"',"condition":"'"$condition"'","run":'"$run_idx"',"quality":'"$quality"',"metrics":{"input_tokens":0,"output_tokens":0,"tool_calls":0,"reads":0,"edits":0,"writes":0,"greps":0,"globs":0,"wall_ms":0,"context_reads":0},"retrospective":null}'
  echo "$record" >> "$RESULTS_FILE"

  log "    Quality: $quality, Tool calls: $(jq -r '.tool_calls // "?"' <<< "$metrics_json" 2>/dev/null || echo "?")"
}

# Force all pipes to legacy/file mode in a worktree's config.yml.
# Bench requires real files (not FIFOs) so context is inspectable and
# survives rsync/cp without a running daemon.
force_legacy_mode() {
  local dir="$1"
  local config="$dir/.pipemd/config.yml"
  if [ ! -f "$config" ]; then return; fi
  # Add or replace mode: legacy on every pipe entry
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

# Remove any stale FIFOs and ensure context files are regular files
clean_fifos() {
  local dir="$1"
  for f in AGENTS.md CLAUDE.md AI_CONTEXT.md; do
    local target="$dir/$f"
    if [ -p "$target" ]; then
      rm -f "$target"
    fi
  done
}

# Setup worktree for a condition
setup_worktree() {
  local base_repo="$1"
  local worktree_dir="$2"
  local condition="$3"

  rm -rf "$worktree_dir" 2>/dev/null || true

  if [ "$condition" = "without" ]; then
    # Pristine copy — no .pipemd/, no AGENTS.md
    cp -r "$base_repo" "$worktree_dir"
    rm -rf "$worktree_dir/.pipemd" 2>/dev/null || true
    rm -f "$worktree_dir/AGENTS.md" "$worktree_dir/AI_CONTEXT.md" 2>/dev/null || true
    # Install dependencies (needed for tsc)
    if [ -f "$worktree_dir/package.json" ]; then
      (cd "$worktree_dir" && npm install --silent 2>/dev/null || pnpm install --silent 2>/dev/null || bun install --silent 2>/dev/null || true)
    fi
  else
    # Full copy with .pipemd/ (used by both "with" and "passive")
    cp -r "$base_repo" "$worktree_dir"
    # Ensure dependencies are installed
    if [ -f "$worktree_dir/package.json" ]; then
      (cd "$worktree_dir" && npm install --silent 2>/dev/null || pnpm install --silent 2>/dev/null || bun install --silent 2>/dev/null || true)
    fi
  fi
}

# Main execution
log "=== PipeMD Agent A/B Benchmark (3-condition) ==="
log "Model: $MODEL"
log "Default runs per cell: $RUNS (overridden per-scenario)"
log "Scenarios: $SCENARIOS"
log "Conditions: full (daemon+plugin), passive (snapshot only), none"
log ""

# Prepare the "with PipeMD" version of each target repo
# For pipemd: use the current repo (already has .pipemd/)
# For hono: need to run pmd init first

HONO_WITH_DIR="$RESULTS_DIR/hono-with-pmd"
HONO_WITHOUT_DIR="$RESULTS_DIR/hono-without-pmd"
PIPEMD_WITH_DIR="$RESULTS_DIR/pipemd-with-pmd"
PIPEMD_WITHOUT_DIR="$RESULTS_DIR/pipemd-without-pmd"

for s in "${SCEN[@]}"; do
  target="${SCENARIO_TARGET[$s]}"
  log "Scenario $s ($target): $(basename "${SCENARIO_PROMPT[$s]}")"

  for condition in with passive without; do
    log "  Condition: $condition"

    if [ "$target" = "pipemd" ]; then
      base="$REPO_ROOT"
      worktree_base="$RESULTS_DIR/pipemd-$condition"
    elif [ "$target" = "bt-lua" ]; then
      base="$SCRIPT_DIR/repos/bt-lua-clean"
      worktree_base="$RESULTS_DIR/bt-lua-$condition"
    else
      base="$SCRIPT_DIR/repos/hono-clean"
      worktree_base="$RESULTS_DIR/hono-$condition"
    fi

    # Setup base worktree — always recreate for clean state
    if [ -d "$worktree_base" ]; then
      rm -rf "$worktree_base"
    fi
    log "  Setting up $condition base..."
    if [ "$target" = "pipemd" ]; then
      mkdir -p "$worktree_base"
      rsync -a --exclude='node_modules' --exclude='.git' --exclude='bench/results' --exclude='dist' "$base/" "$worktree_base/"
      (cd "$worktree_base" && git init -q && git add -A && git commit -qm "baseline" 2>/dev/null || true)
      (cd "$worktree_base" && pnpm install --silent 2>/dev/null || true)
      if [ "$condition" = "without" ]; then
        rm -rf "$worktree_base/.pipemd" "$worktree_base/AGENTS.md" "$worktree_base/AI_CONTEXT.md" "$worktree_base/.opencode" 2>/dev/null || true
      elif [ "$condition" = "passive" ]; then
        force_legacy_mode "$worktree_base"
        clean_fifos "$worktree_base"
        mkdir -p "$worktree_base/.opencode/plugin"
        echo '{"delivery":"passive"}' > "$worktree_base/.opencode/plugin/pmd-config.json"
        # Render AGENTS.md snapshot, then freeze
        (cd "$worktree_base" && pmd start) 2>/dev/null || true
        _pmd_wait=0
        while [ $_pmd_wait -lt 90 ]; do
          sleep 1; _pmd_wait=$((_pmd_wait + 1))
          [ -f "$worktree_base/AGENTS.md" ] && grep -q 'pmd:' "$worktree_base/AGENTS.md" 2>/dev/null && break
        done
        # Kill daemon directly — pmd stop calls cleanStaleState() which deletes AGENTS.md
        _pid=$(cat "$worktree_base/.pipemd/.daemon.pid" 2>/dev/null)
        [ -n "$_pid" ] && kill "$_pid" 2>/dev/null || true
        rm -f "$worktree_base/.pipemd/.daemon.pid" 2>/dev/null || true
        if [ -f "$worktree_base/AGENTS.md" ] && grep -q 'pmd:' "$worktree_base/AGENTS.md" 2>/dev/null; then
          log "    Passive snapshot rendered (${_pmd_wait}s)"
        else
          log "    WARNING: Passive snapshot failed — AGENTS.md not rendered after ${_pmd_wait}s"
        fi
      else
        force_legacy_mode "$worktree_base"
        clean_fifos "$worktree_base"
        # Install opencode plugin for active injection
        mkdir -p "$worktree_base/.opencode/plugin"
        cp "$REPO_ROOT/.opencode/plugin/pmd-crew.js" "$worktree_base/.opencode/plugin/" 2>/dev/null || true
        cp "$REPO_ROOT/.opencode/plugin/pmd-config.json" "$worktree_base/.opencode/plugin/" 2>/dev/null || true
      fi
    else
      setup_worktree "$base" "$worktree_base" "$condition"
      if [ "$condition" = "with" ]; then
        log "  Running pmd init on $target ($condition)..."
        if ! (cd "$worktree_base" && pmd init --yes) >/dev/null 2>&1; then
          log "  WARNING: pmd init failed — condition may degrade to 'without'"
        fi
        force_legacy_mode "$worktree_base"
        clean_fifos "$worktree_base"
        # Install opencode plugin for active injection
        mkdir -p "$worktree_base/.opencode/plugin"
        cp "$REPO_ROOT/.opencode/plugin/pmd-crew.js" "$worktree_base/.opencode/plugin/" 2>/dev/null || true
        cp "$REPO_ROOT/.opencode/plugin/pmd-config.json" "$worktree_base/.opencode/plugin/" 2>/dev/null || true
      elif [ "$condition" = "passive" ]; then
        log "  Running pmd init on $target (passive snapshot)..."
        if ! (cd "$worktree_base" && pmd init --yes) >/dev/null 2>&1; then
          log "  WARNING: pmd init failed — passive snapshot may be empty"
        fi
        force_legacy_mode "$worktree_base"
        clean_fifos "$worktree_base"
        # Render AGENTS.md snapshot, then freeze — no plugin, no daemon
        (cd "$worktree_base" && pmd start) 2>/dev/null || true
        _pmd_wait=0
        while [ $_pmd_wait -lt 90 ]; do
          sleep 1; _pmd_wait=$((_pmd_wait + 1))
          [ -f "$worktree_base/AGENTS.md" ] && grep -q 'pmd:' "$worktree_base/AGENTS.md" 2>/dev/null && break
        done
        # Kill daemon directly — pmd stop calls cleanStaleState() which deletes AGENTS.md
        _pid=$(cat "$worktree_base/.pipemd/.daemon.pid" 2>/dev/null)
        [ -n "$_pid" ] && kill "$_pid" 2>/dev/null || true
        rm -f "$worktree_base/.pipemd/.daemon.pid" 2>/dev/null || true
        if [ -f "$worktree_base/AGENTS.md" ] && grep -q 'pmd:' "$worktree_base/AGENTS.md" 2>/dev/null; then
          log "    Passive snapshot rendered (${_pmd_wait}s)"
        else
          log "    WARNING: Passive snapshot failed — AGENTS.md not rendered after ${_pmd_wait}s"
        fi
      fi
    fi

    # Commit baseline so quality checks see a clean git diff
    if [ -d "$worktree_base/.git" ]; then
      (cd "$worktree_base" && git add -A && git commit -qm "pmd baseline" 2>/dev/null || true)
    fi

    # Write opencode.json with auto-approve permissions for the worktree
    cat > "$worktree_base/opencode.json" << 'PERM_EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "read": "allow",
    "edit": "allow",
    "write": "allow",
    "bash": "allow",
    "glob": "allow",
    "grep": "allow",
    "list": "allow",
    "task": "allow"
  }
}
PERM_EOF

    cell_runs=${SCENARIO_RUNS[$s]:-$RUNS}
    for (( r=1; r<=cell_runs; r++ )); do
      # Resume: skip runs already present in JSONL
      if [ -f "$RESULTS_FILE" ] && grep -q "\"scenario\":$s,\"condition\":\"$condition\",\"run\":$r[^0-9]" "$RESULTS_FILE" 2>/dev/null; then
        log "  Run $r/$cell_runs: s${s}-${condition}-r${r} (skip — already recorded)"
        continue
      fi
      # Create per-run worktree from the base
      run_dir="$RESULTS_DIR/run-s${s}-${condition}-r${r}"
      rm -rf "$run_dir" 2>/dev/null || true
      cp -r "$worktree_base" "$run_dir"

      run_cell "$s" "$condition" "$r" "$run_dir" "${SCENARIO_PROMPT[$s]}" "$run_dir" || true

      # Clean up worktree
      rm -rf "$run_dir" 2>/dev/null || true
    done
  done
done

log ""
log "=== Results ==="
log "Raw data: $RESULTS_FILE"
log ""

# Generate summary
log "Generating summary..."
node -e "
const fs = require('fs');
const lines = fs.readFileSync('$RESULTS_FILE', 'utf8').split('\n').filter(l => l.trim());
const meta = JSON.parse(lines[0]);
const runs = lines.slice(1).map(l => JSON.parse(l));
const voidRuns = runs.filter(r => r.quality === -1);
const groups = {};
for (const r of runs) { if (r.quality === -1) continue; const key = r.scenario + '-' + r.condition; if (!groups[key]) groups[key] = []; groups[key].push(r); }
const scenarios = [...new Set(runs.filter(r => r.quality !== -1).map(r => r.scenario))].sort();
if (voidRuns.length > 0) console.log('VOID runs excluded: ' + voidRuns.length + ' (' + voidRuns.map(v => 's' + v.scenario + '-' + v.condition + '-r' + v.run + ' (' + (v.metrics.reason || 'unknown') + ')').join(', ') + ')');
const OUTPUT_WEIGHT = 4;
const pct = (a, b) => { if (a == null || b == null || !b) return '-'; const d = ((a - b) / b * 100).toFixed(0); return (d > 0 ? '+' : '') + d + '%'; };
const med = (arr) => { if (!arr || !arr.length) return null; const s = [...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };
for (const s of scenarios) {
  const full = groups[s + '-with'] || [];
  const passive = groups[s + '-passive'] || [];
  const none = groups[s + '-without'] || [];
  const stats = (data) => {
    if (!data.length) return null;
    const m = data.map(d => d.metrics);
    return {
      tc: med(m.map(x => x.tool_calls)), r: med(m.map(x => x.reads)),
      search: med(m.map(x => (x.greps||0) + (x.globs||0))),
      it: med(m.map(x => x.input_tokens)), ot: med(m.map(x => x.output_tokens)),
      blend: med(m.map(x => (x.input_tokens||0) + OUTPUT_WEIGHT * (x.output_tokens||0))),
      w: med(m.map(x => x.wall_ms)), fti: med(m.map(x => x.first_turn_input || 0)),
      inj: med(m.map(x => x.injections_delivered || 0)), dedup: med(m.map(x => x.dedup_hits || 0)),
      q: med(data.map(d => d.quality)),
    };
  };
  const sf = stats(full), sp = stats(passive), sn = stats(none);
  const fmt = (v) => v != null ? String(v) : '-';
  const n = (d) => d ? d.length : 0;
  const qstr = (sf?sf.q:'?') + '/' + (sp?sp.q:'?') + '/' + (sn?sn.q:'?');
  console.log('');
  console.log('=== Scenario ' + s + ' (N=' + n(full) + '/' + n(passive) + '/' + n(none) + ', Q=' + qstr + ') ===');
  console.log('                      FULL            PASSIVE         NONE');
  const conditions = [['F', sf], ['P', sp], ['N', sn]];
  const printRow = (label, fn) => {
    const vals = conditions.map(([, st]) => fmt(st ? fn(st) : null).padEnd(16)).join('');
    console.log('  ' + label.padEnd(18) + vals);
  };
  printRow('tool_calls', st => st.tc);
  printRow('reads', st => st.r);
  printRow('greps+globs', st => st.search);
  printRow('input_tokens', st => st.it);
  printRow('output_tokens', st => st.ot);
  printRow('blended_cost', st => st.blend);
  printRow('wall_ms', st => st.w);
  printRow('first_turn_in', st => st.fti);
  printRow('injections', st => st.inj);
  printRow('dedup_hits', st => st.dedup);
  if (sp && sn) console.log('  Static Δ  (P vs N):   reads ' + pct(sp.r, sn.r) + ', blended ' + pct(sp.blend, sn.blend) + ', wall ' + pct(sp.w, sn.w) + ', output ' + pct(sp.ot, sn.ot));
  if (sf && sp) console.log('  Inject Δ  (F vs P):   reads ' + pct(sf.r, sp.r) + ', blended ' + pct(sf.blend, sp.blend) + ', wall ' + pct(sf.w, sp.w) + ', output ' + pct(sf.ot, sp.ot));
  if (sf && sn) console.log('  Total Δ   (F vs N):   reads ' + pct(sf.r, sn.r) + ', blended ' + pct(sf.blend, sn.blend) + ', wall ' + pct(sf.w, sn.w) + ', output ' + pct(sf.ot, sn.ot));
}
console.log('');
console.log('blended_cost = input + ' + OUTPUT_WEIGHT + 'x output | Static=passive vs none | Inject=full vs passive');
const retros = runs.filter(d => d.retrospective).map(d => d.retrospective);
if (retros.length > 0) { console.log(''); console.log('=== Retrospectives ==='); retros.forEach(r => console.log('  ' + r)); }
" 2>/dev/null

# Generate HTML report
log "Generating HTML report..."
bash "$SCRIPT_DIR/report-html.sh" "$RESULTS_FILE" 2>/dev/null || log "  (report generation failed)"

log "Done."
