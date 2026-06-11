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
SCENARIO_PROMPTS_DIR="$SCRIPT_DIR/prompts"

node -e "
const fs = require('fs');
const path = require('path');

const input = process.argv[1];
const output = process.argv[2];
const resultsDir = process.argv[3];
const repoRoot = process.argv[4];
const scenarioNames = JSON.parse(process.argv[5]);
const scenarioTargets = JSON.parse(process.argv[6]);
const promptsDir = process.argv[7];

const lines = fs.readFileSync(input, 'utf8').split('\n').filter(l => l.trim());
if (lines.length < 2) {
  fs.writeFileSync(output, '<html><body><h1>No run data found</h1></body></html>');
  process.exit(0);
}

const meta = JSON.parse(lines[0]);
const runs = lines.slice(1).map(l => JSON.parse(l));

// Group by scenario+condition
const groups = {};
for (const r of runs) {
  const key = r.scenario + '-' + r.condition;
  if (!groups[key]) groups[key] = [];
  groups[key].push(r);
}
const scenarios = [...new Set(runs.map(r => r.scenario))].sort();

// Stats helpers
const median = (arr) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pct = (a, b) => {
  if (!b) return 0;
  return ((a - b) / b * 100);
};
const fmt = (v) => v != null ? v.toLocaleString() : '-';
const fmtMs = (v) => v != null ? (v / 1000).toFixed(1) + 's' : '-';

function computeStats(data) {
  if (data.length === 0) return null;
  const m = data.map(d => d.metrics);
  const q = data.map(d => d.quality);
  const stat = (fn) => {
    const vals = m.map(fn).filter(v => v != null);
    if (vals.length === 0) return { med: null, min: null, max: null };
    return { med: median(vals), min: Math.min(...vals), max: Math.max(...vals) };
  };
  return {
    tc: stat(m => m.tool_calls),
    r: stat(m => m.reads),
    e: stat(m => m.edits),
    it: stat(m => m.input_tokens),
    ot: stat(m => m.output_tokens),
    w: stat(m => m.wall_ms),
    cr: stat(m => m.context_reads || 0),
    q: median(q),
    n: data.length,
  };
}

function readRetro(retroPath) {
  if (!retroPath) return null;
  try {
    const abs = path.isAbsolute(retroPath) ? retroPath : path.join(repoRoot, retroPath);
    return fs.readFileSync(abs, 'utf8');
  } catch { return null; }
}

function readPrompt(scenario) {
  try {
    const file = path.join(promptsDir, '0' + scenario + '-*.md');
    const glob = require('glob');
    const matches = glob.sync(path.join(promptsDir, '0' + scenario + '-*.md'));
    if (matches.length > 0) return fs.readFileSync(matches[0], 'utf8');
  } catch {}
  const files = fs.readdirSync(promptsDir).filter(f => f.startsWith('0' + scenario + '-'));
  if (files.length > 0) return fs.readFileSync(path.join(promptsDir, files[0]), 'utf8');
  return null;
}

// Color helpers
const deltaColor = (metric, delta) => {
  if (delta == null || isNaN(delta)) return '#6b7280';
  const abs = Math.abs(delta);
  // For input_tokens: higher is expected (context tax), so neutral/yellow
  if (metric === 'input_tokens') {
    return delta > 0 ? '#facc15' : '#4ade80'; // yellow=tax, green=lower
  }
  // For quality: higher is better
  if (metric === 'quality') {
    return delta > 0 ? '#4ade80' : '#f87171';
  }
  // All others: lower is better (fewer calls, fewer tokens, less time)
  return delta < 0 ? '#4ade80' : delta > 0 ? '#f87171' : '#6b7280';
};

const qualityBadge = (q) => {
  const colors = { 0: '#ef4444', 1: '#f59e0b', 2: '#22c55e', '-1': '#6b7280' };
  const labels = { 0: 'Broken', 1: 'Partial', 2: 'Complete', '-1': 'Void' };
  return '<span style=\"display:inline-block;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;' +
    'background:' + (colors[q] || '#6b7280') + '20;color:' + (colors[q] || '#6b7280') + ';' +
    'border:1px solid ' + (colors[q] || '#6b7280') + '40\">' + (labels[q] || 'N/A') + '</span>';
};

const verdictBadge = (v) => {
  const colors = { PASS: '#22c55e', WEAK: '#f59e0b', VOID: '#ef4444', INCONCLUSIVE: '#6b7280' };
  const bg = (colors[v] || '#6b7280') + '20';
  const fg = colors[v] || '#6b7280';
  return '<div style=\"margin-top:12px;padding:8px 16px;border-radius:8px;font-weight:700;font-size:14px;' +
    'background:' + bg + ';color:' + fg + ';border:1px solid ' + fg + '40;display:inline-block\">' +
    'VERDICT: ' + v + '</div>';
};

// SVG bar helper
function svgBar(withVal, withoutVal, maxVal, wColor, woColor) {
  const W = 120, H = 14;
  if (!maxVal) maxVal = Math.max(withVal || 0, withoutVal || 0, 1);
  const wW = withVal != null ? Math.max(2, (withVal / maxVal) * W) : 0;
  const woW = withoutVal != null ? Math.max(2, (withoutVal / maxVal) * W) : 0;
  return '<svg width=\"' + (W + 4) + '\" height=\"' + (H * 2 + 4) + '\" style=\"vertical-align:middle\">' +
    '<rect x=\"0\" y=\"0\" width=\"' + wW + '\" height=\"' + H + '\" rx=\"3\" fill=\"' + wColor + '\" opacity=\"0.7\"/>' +
    '<rect x=\"0\" y=\"' + (H + 2) + '\" width=\"' + woW + '\" height=\"' + H + '\" rx=\"3\" fill=\"' + woColor + '\" opacity=\"0.7\"/>' +
    '</svg>';
}

// Compute verdict
function computeVerdict(sw, swo, withData) {
  const itW = sw && sw.it && sw.it.med || 0;
  const itWo = swo && swo.it && swo.it.med || 0;
  const itDelta = itWo > 0 ? ((itW - itWo) / itWo * 100) : 0;
  const consumed = itDelta > 20;
  const readsW = sw && sw.r && sw.r.med || 0;
  const readsWo = swo && swo.r && swo.r.med || 0;
  const qW = sw && sw.q, qWo = swo && swo.q;

  let verdict, detail;
  if (!consumed && withData.length > 0) {
    verdict = 'VOID';
    detail = 'Context not consumed (input_tokens WITH=' + fmt(itW) + ' vs WITHOUT=' + fmt(itWo) + ', delta=' + itDelta.toFixed(0) + '%)';
  } else if (consumed && qW === qWo && readsW < readsWo) {
    verdict = 'PASS';
    detail = 'Context consumed (+' + itDelta.toFixed(0) + '% input tokens), equal quality, fewer exploration reads';
  } else if (consumed && qW === qWo && readsW >= readsWo) {
    verdict = 'WEAK';
    detail = 'Context consumed (+' + itDelta.toFixed(0) + '% input tokens), equal quality, but no reduction in reads';
  } else if (consumed && qW !== qWo) {
    verdict = 'INCONCLUSIVE';
    detail = 'Quality grades differ (' + qW + ' vs ' + qWo + '), cannot compare efficiency';
  } else {
    verdict = 'INCONCLUSIVE';
    detail = 'Insufficient data';
  }
  return { verdict, detail, consumed, itDelta, itW, itWo };
}

// Build HTML
const metricsDef = [
  { key: 'tc', label: 'Tool Calls', fn: m => m.tool_calls, lower: true },
  { key: 'r', label: 'Reads', fn: m => m.reads, lower: true },
  { key: 'e', label: 'Edits', fn: m => m.edits, lower: true },
  { key: 'it', label: 'Input Tokens', fn: m => m.input_tokens, lower: false },
  { key: 'ot', label: 'Output Tokens', fn: m => m.output_tokens, lower: true },
  { key: 'w', label: 'Wall Time', fn: m => m.wall_ms, fmt: fmtMs, lower: true },
  { key: 'cr', label: 'Context Reads', fn: m => m.context_reads || 0, lower: true },
];

function scenarioCard(s) {
  const withData = groups[s + '-with'] || [];
  const withoutData = groups[s + '-without'] || [];
  const sw = computeStats(withData);
  const swo = computeStats(withoutData);
  const name = scenarioNames[s] || ('Scenario ' + s);
  const target = scenarioTargets[s] || '?';
  const prompt = readPrompt(s);
  const promptFirstLine = prompt ? prompt.split('\\n')[0] : '';

  const v = computeVerdict(sw, swo, withData);

  // Per-run detail rows
  const maxRuns = Math.max(withData.length, withoutData.length);
  let detailRows = '';
  for (let i = 0; i < maxRuns; i++) {
    const w = withData[i], wo = withoutData[i];
    detailRows += '<tr>' +
      '<td style=\"color:#94a3b8\">' + (i + 1) + '</td>' +
      '<td>' + qualityBadge(w ? w.quality : null) + '</td>' +
      '<td class=\"num\">' + (w && w.metrics ? fmt(w.metrics.tool_calls) : '-') + '</td>' +
      '<td class=\"num\">' + (w && w.metrics ? fmt(w.metrics.reads) : '-') + '</td>' +
      '<td class=\"num\">' + (w && w.metrics ? fmt(w.metrics.input_tokens) : '-') + '</td>' +
      '<td class=\"num\">' + (w && w.metrics ? fmtMs(w.metrics.wall_ms) : '-') + '</td>' +
      '<td style=\"border-left:2px solid #334155\">' + qualityBadge(wo ? wo.quality : null) + '</td>' +
      '<td class=\"num\">' + (wo && wo.metrics ? fmt(wo.metrics.tool_calls) : '-') + '</td>' +
      '<td class=\"num\">' + (wo && wo.metrics ? fmt(wo.metrics.reads) : '-') + '</td>' +
      '<td class=\"num\">' + (wo && wo.metrics ? fmt(wo.metrics.input_tokens) : '-') + '</td>' +
      '<td class=\"num\">' + (wo && wo.metrics ? fmtMs(wo.metrics.wall_ms) : '-') + '</td>' +
      '</tr>';
  }

  // Comparison table rows
  let compRows = '';
  for (const md of metricsDef) {
    const wv = sw && sw[md.key] || null;
    const wov = swo && swo[md.key] || null;
    const wMed = wv && wv.med;
    const woMed = wov && wov.med;
    const delta = (wMed != null && woMed != null && woMed > 0) ? pct(wMed, woMed) : null;
    const color = delta != null ? deltaColor(md.key === 'it' ? 'input_tokens' : md.key, delta) : '#6b7280';
    const f = md.fmt || fmt;
    const wStr = wv && wv.med != null ? f(wv.med) + ' <span class=\"range\">(' + f(wv.min) + '–' + f(wv.max) + ')</span>' : '-';
    const woStr = wov && wov.med != null ? f(wov.med) + ' <span class=\"range\">(' + f(wov.min) + '–' + f(wov.max) + ')</span>' : '-';
    const deltaStr = delta != null ? '<span style=\"color:' + color + ';font-weight:600\">' + (delta > 0 ? '+' : '') + delta.toFixed(0) + '%</span>' : '-';
    const maxBar = Math.max(wMed || 0, woMed || 0, 1);
    const bar = svgBar(wMed, woMed, maxBar, '#60a5fa', '#fb923c');

    compRows += '<tr>' +
      '<td class=\"metric-label\">' + md.label + '</td>' +
      '<td class=\"num\">' + wStr + '</td>' +
      '<td class=\"num\">' + woStr + '</td>' +
      '<td class=\"num\">' + deltaStr + '</td>' +
      '<td>' + bar + '</td>' +
      '</tr>';
  }

  // Quality row (separate, special handling)
  const qW = sw ? sw.q : null;
  const qWo = swo ? swo.q : null;
  const qDelta = (qW != null && qWo != null) ? qW - qWo : null;
  const qColor = qDelta != null ? deltaColor('quality', qDelta) : '#6b7280';
  compRows += '<tr style=\"border-top:2px solid #334155\">' +
    '<td class=\"metric-label\" style=\"font-weight:700\">Quality Grade</td>' +
    '<td>' + qualityBadge(qW) + '</td>' +
    '<td>' + qualityBadge(qWo) + '</td>' +
    '<td class=\"num\"><span style=\"color:' + qColor + ';font-weight:600\">' + (qDelta != null ? (qDelta > 0 ? '+' : '') + qDelta : '-') + '</span></td>' +
    '<td></td></tr>';

  // N runs row
  compRows += '<tr style=\"opacity:0.6\"><td class=\"metric-label\">Runs (N)</td>' +
    '<td class=\"num\">' + (sw ? sw.n : 0) + '</td>' +
    '<td class=\"num\">' + (swo ? swo.n : 0) + '</td>' +
    '<td></td><td></td></tr>';

  // Retrospective
  const retroFiles = withData.filter(d => d.retrospective);
  let retroHtml = '';
  if (retroFiles.length > 0) {
    retroHtml = '<div class=\"retro-section\">' +
      '<h3>Retrospective Feedback</h3>';
    for (const rd of retroFiles) {
      const text = readRetro(rd.retrospective);
      if (text) {
        retroHtml += '<details><summary>Run ' + rd.run + '</summary>' +
          '<pre class=\"retro-text\">' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>' +
          '</details>';
      }
    }
    retroHtml += '</div>';
  }

  // Prompt
  let promptHtml = '';
  if (prompt) {
    promptHtml = '<details class=\"prompt-details\"><summary>Task Prompt</summary>' +
      '<pre class=\"prompt-text\">' + prompt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>' +
      '</details>';
  }

  return '<div class=\"scenario-card\" id=\"scenario-' + s + '\">' +
    '<div class=\"scenario-header\">' +
    '<h2>' + name + '</h2>' +
    '<div class=\"scenario-meta\">' +
    '<span class=\"tag\">Target: ' + target + '</span>' +
    '<span class=\"tag\">' + promptFirstLine + '</span>' +
    '</div>' +
    '</div>' +

    // Comparison table
    '<table class=\"comp-table\">' +
    '<thead><tr>' +
    '<th>Metric</th><th class=\"with-col\">WITH PipeMD</th><th class=\"without-col\">WITHOUT</th><th>Delta</th><th>Visual</th>' +
    '</tr></thead>' +
    '<tbody>' + compRows + '</tbody></table>' +

    // Verdict
    verdictBadge(v.verdict) +
    '<div class=\"verdict-detail\">' + v.detail + '</div>' +
    '<div class=\"consumption-note\">Consumption: input_tokens delta = ' + (v.itDelta || 0).toFixed(0) + '% (WITH=' + fmt(v.itW) + ', WITHOUT=' + fmt(v.itWo) + ')</div>' +

    // Per-run detail
    '<details class=\"run-details\"><summary>Per-Run Detail (' + maxRuns + ' runs)</summary>' +
    '<table class=\"detail-table\">' +
    '<thead><tr>' +
    '<th>#</th><th colspan=\"4\" class=\"with-col\">WITH PipeMD</th><th colspan=\"4\" class=\"without-col\">WITHOUT</th>' +
    '</tr><tr>' +
    '<th></th>' +
    '<th class=\"with-col\">Quality</th><th class=\"with-col\">Calls</th><th class=\"with-col\">Reads</th><th class=\"with-col\">Tokens In</th><th class=\"with-col\">Time</th>' +
    '<th class=\"without-col\">Quality</th><th class=\"without-col\">Calls</th><th class=\"without-col\">Reads</th><th class=\"without-col\">Tokens In</th><th class=\"without-col\">Time</th>' +
    '</tr></thead>' +
    '<tbody>' + detailRows + '</tbody></table>' +
    '</details>' +

    retroHtml +
    promptHtml +
    '</div>';
}

// Methodology section
const methodology = '<div class=\"methodology-card\">' +
  '<h2>Methodology</h2>' +
  '<table class=\"meth-table\">' +
  '<tr><td class=\"meth-label\">Quality-First Rule</td><td>Efficiency metrics are only compared between runs at the same quality grade. Fast-but-broken does not beat slow-but-correct.</td></tr>' +
  '<tr><td class=\"meth-label\">Consumption Signal</td><td>AGENTS.md is auto-loaded into the system prompt at session start. Consumption is detected via input_tokens(WITH) &gt; input_tokens(WITHOUT), not read tool-calls.</td></tr>' +
  '<tr><td class=\"meth-label\">First-Turn Note</td><td>Summed input_tokens is confounded by turn count. For calibration, check the first turn in raw NDJSON — WITH should be ~5k tokens higher than WITHOUT.</td></tr>' +
  '<tr><td class=\"meth-label\">Delivery Mode</td><td>Legacy/file mode forced for bench (not FIFO). AGENTS.md is a regular file on disk, rendered by the daemon before the agent starts.</td></tr>' +
  '<tr><td class=\"meth-label\">Render Timeout</td><td>Daemon has 60s to render AGENTS.md. Failed renders mark the cell VOID and exclude it from analysis.</td></tr>' +
  '<tr><td class=\"meth-label\">Context Tax</td><td>input_tokens will be HIGHER with PipeMD (the context costs tokens). The value hypothesis is that output_tokens, tool_calls, reads, and wall_ms should be LOWER.</td></tr>' +
  '</table>' +
  '</div>';

// Raw data
const rawJsonl = lines.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('\\n');

// Build full HTML
const scenarioCards = scenarios.map(s => scenarioCard(s)).join('\\n');

const html = '<!DOCTYPE html>' +
'<html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">' +
'<title>PipeMD Bench Report — ' + meta.timestamp + '</title>' +
'<style>' +
':root { --bg: #0f172a; --card: #1e293b; --border: #334155; --text: #e2e8f0; --dim: #94a3b8; --with: #60a5fa; --without: #fb923c; }' +
'* { margin: 0; padding: 0; box-sizing: border-box; }' +
'body { font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 24px; max-width: 1100px; margin: 0 auto; }' +
'h1 { font-size: 24px; margin-bottom: 4px; }' +
'h2 { font-size: 18px; margin-bottom: 8px; }' +
'h3 { font-size: 15px; margin-bottom: 8px; color: var(--dim); }' +
'.header { margin-bottom: 32px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }' +
'.header-meta { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; }' +
'.header-meta span { font-size: 13px; color: var(--dim); background: var(--card); padding: 2px 10px; border-radius: 6px; border: 1px solid var(--border); }' +
'.scenario-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }' +
'.scenario-header { margin-bottom: 16px; }' +
'.scenario-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }' +
'.tag { font-size: 12px; color: var(--dim); background: var(--bg); padding: 2px 8px; border-radius: 4px; }' +
'.comp-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 12px; }' +
'.comp-table th { text-align: left; padding: 6px 10px; color: var(--dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }' +
'.comp-table td { padding: 5px 10px; border-bottom: 1px solid #1a2332; }' +
'.comp-table .num { text-align: right; font-variant-numeric: tabular-nums; }' +
'.comp-table .metric-label { font-weight: 500; color: var(--dim); }' +
'.comp-table .range { color: #475569; font-size: 11px; }' +
'.comp-table .with-col { color: var(--with); }' +
'.comp-table .without-col { color: var(--without); }' +
'.comp-table th.with-col { color: var(--with); }' +
'.comp-table th.without-col { color: var(--without); }' +
'.verdict-detail { font-size: 13px; color: var(--dim); margin-top: 4px; }' +
'.consumption-note { font-size: 12px; color: #475569; margin-top: 4px; font-style: italic; }' +
'.detail-table { width: 100%; border-collapse: collapse; font-size: 12px; }' +
'.detail-table th { text-align: right; padding: 4px 8px; color: var(--dim); font-weight: 600; font-size: 10px; text-transform: uppercase; border-bottom: 1px solid var(--border); }' +
'.detail-table th:first-child { text-align: center; }' +
'.detail-table td { padding: 3px 8px; text-align: right; border-bottom: 1px solid #1a2332; }' +
'.detail-table .num { font-variant-numeric: tabular-nums; }' +
'.run-details { margin-top: 16px; }' +
'.run-details summary { cursor: pointer; color: var(--dim); font-size: 13px; padding: 6px 0; }' +
'.run-details summary:hover { color: var(--text); }' +
'.prompt-details { margin-top: 8px; }' +
'.prompt-details summary { cursor: pointer; color: var(--dim); font-size: 12px; }' +
'.prompt-text { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-size: 12px; overflow-x: auto; margin-top: 8px; white-space: pre-wrap; }' +
'.retro-section { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px; }' +
'.retro-section details summary { cursor: pointer; color: var(--with); font-size: 13px; padding: 4px 0; }' +
'.retro-text { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-size: 12px; overflow-x: auto; margin-top: 4px; white-space: pre-wrap; color: var(--text); }' +
'.methodology-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }' +
'.meth-table { width: 100%; border-collapse: collapse; font-size: 13px; }' +
'.meth-table td { padding: 6px 10px; border-bottom: 1px solid #1a2332; vertical-align: top; }' +
'.meth-label { font-weight: 600; color: var(--dim); white-space: nowrap; width: 160px; }' +
'.raw-section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }' +
'.raw-section details summary { cursor: pointer; color: var(--dim); font-size: 13px; }' +
'.raw-section pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-size: 11px; overflow-x: auto; margin-top: 8px; max-height: 400px; overflow-y: auto; color: var(--dim); }' +
'</style></head><body>' +

'<div class=\"header\">' +
'<h1>PipeMD Agent A/B Benchmark</h1>' +
'<div class=\"header-meta\">' +
'<span>Model: ' + meta.model + '</span>' +
'<span>Runs/cell: ' + meta.runs_per_cell + '</span>' +
'<span>Timestamp: ' + meta.timestamp + '</span>' +
'<span>Scenarios: ' + scenarios.length + '</span>' +
'<span>Total runs: ' + runs.length + '</span>' +
'</div></div>' +

scenarioCards +

methodology +

'<div class=\"raw-section\"><details><summary>Raw Data (JSONL)</summary><pre>' + rawJsonl + '</pre></details></div>' +

'<footer style=\"text-align:center;color:#475569;font-size:11px;padding:20px 0\">' +
'Generated by bench/report-html.sh &mdash; PipeMD Benchmark Suite</footer>' +

'</body></html>';

fs.writeFileSync(output, html);
console.log('Report written to ' + output);
" "$INPUT" "$OUTPUT" "$RESULTS_DIR" "$REPO_ROOT" "$SCENARIO_NAMES" "$SCENARIO_TARGETS" "$SCENARIO_PROMPTS_DIR"

echo "Report: $OUTPUT"
