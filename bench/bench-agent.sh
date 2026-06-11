#!/usr/bin/env bash
# bench-agent.sh — PipeMD Agent A/B Benchmark Runner
#
# Runs 3 scenarios × 2 conditions (with/without PipeMD) × N repetitions.
# Uses git worktrees for per-run isolation.
# Parses OpenCode NDJSON output for tokens, tool calls, and wall time.
#
# Usage: bash bench/bench-agent.sh [--runs N] [--model MODEL] [--scenarios 1,2,3]
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
RUNS=5
MODEL="zai-coding-plan/glm-5.1"
SCENARIOS="1,2,3"
DRY_RUN=false

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --scenarios) SCENARIOS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      echo "Usage: bash bench/bench-agent.sh [--runs N] [--model MODEL] [--scenarios 1,2,3] [--dry-run]"
      exit 0 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Scenario definitions
declare -A SCENARIO_TARGET SCENARIO_PROMPT SCENARIO_PROJECT SCENARIO_REPO SCENARIO_CHECK
SCENARIO_TARGET[1]="pipemd"
SCENARIO_TARGET[2]="hono"
SCENARIO_TARGET[3]="hono"

SCENARIO_PROMPT[1]="$SCRIPT_DIR/prompts/01-crew-export.pipemd.md"
SCENARIO_PROMPT[2]="$SCRIPT_DIR/prompts/02-middleware-timing.hono.md"
SCENARIO_PROMPT[3]="$SCRIPT_DIR/prompts/03-error-handler.hono.md"

SCENARIO_CHECK[1]="$SCRIPT_DIR/quality/check-01.sh"
SCENARIO_CHECK[2]="$SCRIPT_DIR/quality/check-02.sh"
SCENARIO_CHECK[3]="$SCRIPT_DIR/quality/check-03.sh"

# Parse scenario list
IFS=',' read -ra SCEN <<< "$SCENARIOS"

# Results file
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_FILE="$RESULTS_DIR/run-${TIMESTAMP}.jsonl"
echo "{\"type\":\"meta\",\"timestamp\":\"$TIMESTAMP\",\"model\":\"$MODEL\",\"runs_per_cell\":$RUNS}" > "$RESULTS_FILE"

log() { echo "[$(date +%H:%M:%S)] $*"; }

# Parse NDJSON from opencode run --format json
parse_run_metrics() {
  local ndjson_file="$1"
  local result_file="$2"

  local input_tokens=0 output_tokens=0 tool_calls=0 reads=0 edits=0 writes=0 greps=0 globs=0
  local context_reads=0
  local wall_start="" wall_end=""

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
        local tool_name=$(echo "$line" | jq -r '.part.tool // empty' 2>/dev/null || echo "")
        case "$tool_name" in
          read|file_read) reads=$((reads + 1)) ;;
          edit|file_edit) edits=$((edits + 1)) ;;
          write|file_write) writes=$((writes + 1)) ;;
          grep|search) greps=$((greps + 1)) ;;
          glob|list) globs=$((globs + 1)) ;;
        esac
        # Track context file reads (AGENTS.md, AI_CONTEXT.md, CLAUDE.md)
        local tool_input=$(echo "$line" | jq -r '.part.input // .part.path // .part.args // empty' 2>/dev/null || echo "")
        case "$tool_input" in
          *AGENTS.md*|*AI_CONTEXT.md*|*CLAUDE.md*) context_reads=$((context_reads + 1)) ;;
        esac
        ;;
      step_finish)
        wall_end=$(echo "$line" | jq -r '.timestamp // empty' 2>/dev/null || echo "")
        local part_tokens=$(echo "$line" | jq -c '
          .part.tokens // {} |
          {input: (.input // 0), output: (.output // 0)}
        ' 2>/dev/null || echo '{"input":0,"output":0}')
        if [ "$part_tokens" != "null" ] && [ "$part_tokens" != "" ]; then
          local inp=$(echo "$part_tokens" | jq -r '.input // 0')
          local out=$(echo "$part_tokens" | jq -r '.output // 0')
          input_tokens=$((input_tokens + inp))
          output_tokens=$((output_tokens + out))
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
  jq -n \
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
    '{input_tokens: ($input|tonumber), output_tokens: ($output|tonumber), tool_calls: $tool_calls, reads: $reads, edits: $edits, writes: $writes, greps: $greps, globs: $globs, wall_ms: $wall_ms, context_reads: $context_reads}' \
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

  # For "with" condition: start PipeMD daemon inside the worktree
  if [ "$condition" = "with" ]; then
    if [ -f "$work_dir/.pipemd/config.yml" ]; then
      log "    Starting daemon in $work_dir"
      (cd "$work_dir" && pmd start) 2>/dev/null || true
      # Wait for initial render (commands run synchronously, ~5-8s)
      local waited=0
      while [ $waited -lt 30 ]; do
        sleep 1
        waited=$((waited + 1))
        if [ -f "$work_dir/AGENTS.md" ] && grep -q 'pmd:' "$work_dir/AGENTS.md" 2>/dev/null; then
          break
        fi
      done
      # Verify context was rendered as a regular file with pmd: blocks
      local ctx_file="$work_dir/AGENTS.md"
      if [ -f "$ctx_file" ]; then
        local block_count
        block_count=$(grep -c 'pmd:' "$ctx_file" 2>/dev/null || echo "0")
        log "    Context OK: $block_count pmd: blocks in $(basename "$ctx_file")"
      else
        log "    WARNING: AGENTS.md not found or is not a regular file — context may be missing"
      fi
    fi
  fi

  # Run opencode
  local start_ms
  start_ms=$(date +%s%3N)

  opencode run --format json --model "$MODEL" --dir "$work_dir" "$prompt" \
    > "$ndjson_file" 2>/dev/null || true

  local end_ms
  end_ms=$(date +%s%3N)
  local elapsed_ms=$(( end_ms - start_ms ))

  # Stop daemon if we started it
  if [ "$condition" = "with" ]; then
    (cd "$work_dir" && pmd stop) 2>/dev/null || true
  fi

  # Parse metrics
  parse_run_metrics "$ndjson_file" "$metrics_file"

  # Override wall_ms with external measurement
  if [ -f "$metrics_file" ]; then
    local tmp_metrics
    tmp_metrics=$(jq --argjson wall "$elapsed_ms" '.wall_ms = $wall' "$metrics_file")
    echo "$tmp_metrics" > "$metrics_file"
  fi

  # Quality check — run INSIDE the worktree so relative paths resolve correctly
  local quality=0
  local check_script="${SCENARIO_CHECK[$scenario]}"
  if [ -f "$check_script" ]; then
    quality=$(cd "$work_dir" && bash "$check_script" 2>/dev/null || echo "0")
  fi

  # Record result
  local metrics_json
  metrics_json=$(cat "$metrics_file" 2>/dev/null || echo "{}")

  jq -n \
    --argjson scenario "$scenario" \
    --arg condition "$condition" \
    --argjson run "$run_idx" \
    --argjson quality "$quality" \
    --argjson metrics "$metrics_json" \
    '{scenario: $scenario, condition: $condition, run: $run, quality: $quality, metrics: $metrics}' \
    >> "$RESULTS_FILE"

  log "    Quality: $quality, Tool calls: $(jq -r '.tool_calls // "?"' "$metrics_file" 2>/dev/null)"
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

  if [ "$condition" = "with" ]; then
    # Full copy with .pipemd/ and context file
    cp -r "$base_repo" "$worktree_dir"
    # Ensure dependencies are installed
    if [ -f "$worktree_dir/package.json" ]; then
      (cd "$worktree_dir" && npm install --silent 2>/dev/null || pnpm install --silent 2>/dev/null || bun install --silent 2>/dev/null || true)
    fi
  else
    # Pristine copy — no .pipemd/, no AGENTS.md
    cp -r "$base_repo" "$worktree_dir"
    rm -rf "$worktree_dir/.pipemd" 2>/dev/null || true
    rm -f "$worktree_dir/AGENTS.md" "$worktree_dir/AI_CONTEXT.md" 2>/dev/null || true
    # Install dependencies (needed for tsc)
    if [ -f "$worktree_dir/package.json" ]; then
      (cd "$worktree_dir" && npm install --silent 2>/dev/null || pnpm install --silent 2>/dev/null || bun install --silent 2>/dev/null || true)
    fi
  fi
}

# Main execution
log "=== PipeMD Agent A/B Benchmark ==="
log "Model: $MODEL"
log "Runs per cell: $RUNS"
log "Scenarios: $SCENARIOS"
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

  for condition in with without; do
    log "  Condition: $condition"

    if [ "$target" = "pipemd" ]; then
      base="$REPO_ROOT"
      worktree_base="$RESULTS_DIR/pipemd-$condition"
    else
      base="$SCRIPT_DIR/repos/hono-clean"
      worktree_base="$RESULTS_DIR/hono-$condition"
    fi

    # Setup base worktree once per condition
    if [ ! -d "$worktree_base" ]; then
      log "  Setting up $condition base..."
      if [ "$target" = "pipemd" ]; then
        mkdir -p "$worktree_base"
        rsync -a --exclude='node_modules' --exclude='.git' --exclude='bench/results' --exclude='dist' "$base/" "$worktree_base/"
        (cd "$worktree_base" && pnpm install --silent 2>/dev/null || true)
        if [ "$condition" = "without" ]; then
          rm -rf "$worktree_base/.pipemd" "$worktree_base/AGENTS.md" "$worktree_base/AI_CONTEXT.md" 2>/dev/null || true
        else
          force_legacy_mode "$worktree_base"
          clean_fifos "$worktree_base"
        fi
      else
        setup_worktree "$base" "$worktree_base" "$condition"
        # For "with" on hono: run pmd init inside the worktree
        if [ "$condition" = "with" ]; then
          log "  Running pmd init on hono ($condition)..."
          (cd "$worktree_base" && pmd init --headless) 2>/dev/null || true
          force_legacy_mode "$worktree_base"
          clean_fifos "$worktree_base"
        fi
      fi
    fi

    for (( r=1; r<=RUNS; r++ )); do
      # Create per-run worktree from the base
      run_dir="$RESULTS_DIR/run-s${s}-${condition}-r${r}"
      rm -rf "$run_dir" 2>/dev/null || true
      cp -r "$worktree_base" "$run_dir"

      run_cell "$s" "$condition" "$r" "$run_dir" "${SCENARIO_PROMPT[$s]}" "$run_dir"

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
const groups = {};
for (const r of runs) { const key = r.scenario + '-' + r.condition; if (!groups[key]) groups[key] = []; groups[key].push(r); }
const scenarios = [...new Set(runs.map(r => r.scenario))].sort();
const pct = (a, b) => { if (!a || !b) return ''; const d = ((a - b) / b * 100).toFixed(0); return (d > 0 ? '+' : '') + d + '%'; };
for (const s of scenarios) {
  const withData = groups[s + '-with'] || [];
  const withoutData = groups[s + '-without'] || [];
  const stats = (data) => {
    if (data.length === 0) return {};
    const metrics = data.map(d => d.metrics);
    const quality = data.map(d => d.quality);
    const metric = (fn) => {
      const vals = metrics.map(fn).filter(v => v !== undefined && v !== null);
      if (vals.length === 0) return { med: null, min: null, max: null };
      vals.sort((a, b) => a - b);
      return { med: vals[Math.floor(vals.length / 2)], min: vals[0], max: vals[vals.length - 1] };
    };
    const qMed = () => { quality.sort(); return quality[Math.floor(quality.length / 2)]; };
    return {
      tc: metric(m => m.tool_calls), r: metric(m => m.reads), e: metric(m => m.edits),
      it: metric(m => m.input_tokens), ot: metric(m => m.output_tokens),
      w: metric(m => m.wall_ms), q: qMed(),
    };
  };
  const sw = stats(withData), swo = stats(withoutData);
  const fmt = (v) => v && v.med !== null ? v.med + ' (' + v.min + '-' + v.max + ')' : '-';
  const row = (label, wv, wov) => {
    const w = fmt(wv).padEnd(22), wo = fmt(wov).padEnd(22);
    const delta = (wv && wov && wv.med && wov.med) ? pct(wv.med, wov.med) : '';
    return '  ' + label.padEnd(15) + w + wo + delta;
  };
  console.log('');
  console.log('=== Scenario ' + s + ' (N=' + withData.length + '/' + withoutData.length + ', quality ' + sw.q + '/' + swo.q + ') ===');
  console.log('                    WITH PipeMD             WITHOUT PipeMD          Delta');
  console.log(row('tool_calls', sw.tc, swo.tc));
  console.log(row('reads', sw.r, swo.r));
  console.log(row('edits', sw.e, swo.e));
  console.log(row('input_tokens', sw.it, swo.it));
  console.log(row('output_tokens', sw.ot, swo.ot));
  console.log(row('wall_ms', sw.w, swo.w));
}
console.log('');
console.log('Note: input_tokens will likely be HIGHER with PipeMD (context tax).');
console.log('      output_tokens / tool_calls should be LOWER if PipeMD helps.');
console.log('      Delta is relative to WITHOUT (negative = WITH is smaller).');
" 2>/dev/null

log "Done."
