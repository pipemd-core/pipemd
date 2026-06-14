/* global process, console */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, isAbsolute, dirname } from "node:path";

const [input, output, repoRoot, scenarioNamesRaw, scenarioTargetsRaw, promptsDir] = process.argv.slice(2);

const scenarioNamesFallback = JSON.parse(scenarioNamesRaw);
const scenarioTargetsFallback = JSON.parse(scenarioTargetsRaw);
const resultsDir = dirname(input);
const benchDir = dirname(promptsDir);

let scenarioNames = scenarioNamesFallback;
let scenarioTargets = scenarioTargetsFallback;
try {
  const baselines = JSON.parse(readFileSync(join(benchDir, "baselines.json"), "utf8"));
  const entries = Object.entries(baselines.scenarios || {});
  if (entries.length) {
    const names = {};
    const targets = {};
    entries.forEach(([key, val], i) => {
      const num = String(i + 1);
      const label = key.replace(/^\d+-/, "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      names[num] = label + " (" + (val.target || "?") + ")";
      targets[num] = val.target || "?";
    });
    scenarioNames = names;
    scenarioTargets = targets;
  }
} catch { /* fallback to hardcoded */ }

const lines = readFileSync(input, "utf8").split("\n").filter(l => l.trim());
if (lines.length < 2) {
  writeFileSync(output, "<html><body><h1>No run data found</h1></body></html>");
  process.exit(0);
}

const meta = JSON.parse(lines[0]);
const allRuns = lines.slice(1).map(l => JSON.parse(l));
const runs = allRuns.filter(r => r.quality !== -1);
const voidRuns = allRuns.filter(r => r.quality === -1);

const groups = {};
for (const r of runs) {
  const key = `${r.scenario}-${r.condition}`;
  if (!groups[key]) groups[key] = [];
  groups[key].push(r);
}
const scenarios = [...new Set(runs.map(r => r.scenario))].sort();

function extractFirstTurnTokens(label) {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "");
  const ndjsonPath = join(resultsDir, `${safeLabel}.ndjson`);
  if (!existsSync(ndjsonPath)) return null;
  try {
    const ndjsonLines = readFileSync(ndjsonPath, "utf8").split("\n").filter(l => l.trim());
    for (const line of ndjsonLines) {
      const obj = JSON.parse(line);
      if (obj.type === "step_finish" && obj.part?.tokens?.input) {
        return obj.part.tokens.input;
      }
    }
  } catch { return null; }
  return null;
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pct = (a, b) => (b ? ((a - b) / b) * 100 : 0);
const fmt = (v) => (v != null ? v.toLocaleString() : "-");
const fmtMs = (v) => (v != null ? (v / 1000).toFixed(1) + "s" : "-");
const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function computeStats(data) {
  if (!data.length) return null;
  const m = data.map(d => d.metrics);
  const q = data.map(d => d.quality);
  const stat = (fn) => {
    const vals = m.map(fn).filter(v => v != null);
    if (!vals.length) return { med: null, min: null, max: null };
    return { med: median(vals), min: Math.min(...vals), max: Math.max(...vals) };
  };
  return {
    tc: stat(m => m.tool_calls), r: stat(m => m.reads), e: stat(m => m.edits),
    it: stat(m => m.input_tokens), ot: stat(m => m.output_tokens),
    w: stat(m => m.wall_ms), cr: stat(m => m.context_reads || 0),
    q: median(q), n: data.length,
  };
}

function readRetro(p) {
  if (!p) return null;
  try { return readFileSync(isAbsolute(p) ? p : join(repoRoot, p), "utf8"); }
  catch { return null; }
}

function readPrompt(s) {
  const files = readdirSync(promptsDir).filter(f => f.startsWith(`0${s}-`));
  if (files.length) return readFileSync(join(promptsDir, files[0]), "utf8");
  return null;
}

const COLORS = {
  bg: "#0f172a", card: "#1e293b", border: "#334155", text: "#e2e8f0",
  dim: "#94a3b8", withCol: "#60a5fa", withoutCol: "#fb923c",
  green: "#22c55e", yellow: "#f59e0b", red: "#ef4444", gray: "#6b7280",
};

function deltaColor(metric, delta) {
  if (delta == null || isNaN(delta)) return COLORS.gray;
  if (metric === "input_tokens") return delta > 0 ? COLORS.yellow : COLORS.green;
  if (metric === "quality") return delta > 0 ? COLORS.green : COLORS.red;
  return delta < 0 ? COLORS.green : delta > 0 ? COLORS.red : COLORS.gray;
}

function qualityBadge(q) {
  const c = { 0: COLORS.red, 1: COLORS.yellow, 2: COLORS.green, "-1": COLORS.gray };
  const l = { 0: "Broken", 1: "Partial", 2: "Complete", "-1": "Void" };
  const color = c[q] || COLORS.gray;
  return `<span class="qbadge" style="--c:${color}">${l[q] || "N/A"}</span>`;
}

function svgBar(withVal, withoutVal, maxVal) {
  const W = 200, H = 16, gap = 3;
  maxVal = Math.max(withVal || 0, withoutVal || 0, maxVal || 0, 1);
  const wW = withVal != null ? Math.max(3, (withVal / maxVal) * W) : 0;
  const woW = withoutVal != null ? Math.max(3, (withoutVal / maxVal) * W) : 0;
  return `<svg class="bar-svg" width="${W}" height="${H * 2 + gap}" viewBox="0 0 ${W} ${H * 2 + gap}">
    <rect x="0" y="0" width="${wW}" height="${H}" rx="4" fill="${COLORS.withCol}" opacity="0.75"/>
    <rect x="0" y="${H + gap}" width="${woW}" height="${H}" rx="4" fill="${COLORS.withoutCol}" opacity="0.75"/>
  </svg>`;
}

function computeVerdict(sw, swo, withData) {
  const itW = sw?.it?.med || 0;
  const itWo = swo?.it?.med || 0;
  const itDelta = itWo > 0 ? ((itW - itWo) / itWo) * 100 : 0;
  const consumed = itDelta > 20;
  const readsW = sw?.r?.med || 0;
  const readsWo = swo?.r?.med || 0;
  const qW = sw?.q, qWo = swo?.q;

  // Try first-turn token comparison for unambiguous consumption check
  const ftWith = withData.map(d => {
    const label = `s${d.scenario}-${d.condition}-r${d.run}`;
    return extractFirstTurnTokens(label);
  }).filter(v => v != null);
  const ftWithout = (groups[withData[0]?.scenario + "-without"] || []).map(d => {
    const label = `s${d.scenario}-${d.condition}-r${d.run}`;
    return extractFirstTurnTokens(label);
  }).filter(v => v != null);
  const ftW = ftWith.length ? median(ftWith) : null;
  const ftWo = ftWithout.length ? median(ftWithout) : null;
  const ftDelta = ftW != null && ftWo != null && ftWo > 0 ? ((ftW - ftWo) / ftWo) * 100 : null;

  const useFirstTurn = ftDelta != null;
  const signal = useFirstTurn ? `First-turn: WITH=${fmt(ftW)} vs WITHOUT=${fmt(ftWo)} (${ftDelta > 0 ? "+" : ""}${ftDelta.toFixed(0)}%)` : `Summed: WITH=${fmt(itW)} vs WITHOUT=${fmt(itWo)} (${itDelta > 0 ? "+" : ""}${itDelta.toFixed(0)}%)`;

  let verdict, detail;
  if (!consumed && withData.length > 0) {
    verdict = "VOID"; detail = `Context not consumed (${signal})`;
  } else if (consumed && qW === qWo && readsW < readsWo) {
    verdict = "PASS"; detail = `Context consumed, equal quality, fewer exploration reads (${signal})`;
  } else if (consumed && qW === qWo && readsW >= readsWo) {
    verdict = "WEAK"; detail = `Context consumed, equal quality, but no reduction in reads (${signal})`;
  } else if (consumed && qW !== qWo) {
    verdict = "INCONCLUSIVE"; detail = `Quality grades differ (${qW} vs ${qWo}), cannot compare efficiency`;
  } else {
    verdict = "INCONCLUSIVE"; detail = "Insufficient data";
  }
  return { verdict, detail, consumed, itDelta, itW, itWo, ftDelta, ftW, ftWo, useFirstTurn };
}

const metricsDef = [
  { key: "tc", label: "Tool Calls", fn: m => m.tool_calls, lower: true },
  { key: "r", label: "Reads", fn: m => m.reads, lower: true },
  { key: "e", label: "Edits", fn: m => m.edits, lower: true },
  { key: "it", label: "Input Tokens", fn: m => m.input_tokens, lower: false },
  { key: "ot", label: "Output Tokens", fn: m => m.output_tokens, lower: true },
  { key: "w", label: "Wall Time", fn: m => m.wall_ms, fmt: fmtMs, lower: true },
  { key: "cr", label: "Context Reads", fn: m => m.context_reads || 0, lower: true },
];

function verdictColor(v) {
  return { PASS: COLORS.green, WEAK: COLORS.yellow, VOID: COLORS.red, INCONCLUSIVE: COLORS.gray }[v] || COLORS.gray;
}

function scenarioCard(s) {
  const withData = groups[`${s}-with`] || [];
  const withoutData = groups[`${s}-without`] || [];
  const sw = computeStats(withData);
  const swo = computeStats(withoutData);
  const name = scenarioNames[s] || `Scenario ${s}`;
  const target = scenarioTargets[s] || "?";
  const prompt = readPrompt(s);
  const promptFirstLine = prompt ? prompt.split("\n")[0] : "";
  const v = computeVerdict(sw, swo, withData);
  const vc = verdictColor(v.verdict);
  const maxRuns = Math.max(withData.length, withoutData.length);

  const compRows = metricsDef.map(md => {
    const wv = sw?.[md.key], wov = swo?.[md.key];
    const wMed = wv?.med, woMed = wov?.med;
    const delta = wMed != null && woMed != null && woMed > 0 ? pct(wMed, woMed) : null;
    const color = delta != null ? deltaColor(md.key === "it" ? "input_tokens" : md.key, delta) : COLORS.gray;
    const f = md.fmt || fmt;
    const wStr = wv?.med != null ? `${f(wv.med)} <span class="range">(${f(wv.min)}–${f(wv.max)})</span>` : "-";
    const woStr = wov?.med != null ? `${f(wov.med)} <span class="range">(${f(wov.min)}–${f(wov.max)})</span>` : "-";
    const deltaStr = delta != null
      ? `<span style="color:${color};font-weight:600">${delta > 0 ? "+" : ""}${delta.toFixed(0)}%</span>` : "-";
    const bar = svgBar(wMed, woMed, null);
    return `      <tr>
        <td class="metric-label">${md.label}</td>
        <td class="num">${wStr}</td>
        <td class="num">${woStr}</td>
        <td class="num">${deltaStr}</td>
        <td class="bar-cell">${bar}</td>
      </tr>`;
  }).join("\n");

  const qW = sw?.q, qWo = swo?.q;
  const qDelta = qW != null && qWo != null ? qW - qWo : null;
  const qColor = qDelta != null ? deltaColor("quality", qDelta) : COLORS.gray;

  const detailRows = Array.from({ length: maxRuns }, (_, i) => {
    const w = withData[i], wo = withoutData[i];
    return `        <tr>
          <td class="run-num">${i + 1}</td>
          <td>${qualityBadge(w?.quality)}</td>
          <td class="num">${w ? fmt(w.metrics.tool_calls) : "-"}</td>
          <td class="num">${w ? fmt(w.metrics.reads) : "-"}</td>
          <td class="num">${w ? fmt(w.metrics.input_tokens) : "-"}</td>
          <td class="num">${w ? fmtMs(w.metrics.wall_ms) : "-"}</td>
          <td class="divider">${qualityBadge(wo?.quality)}</td>
          <td class="num">${wo ? fmt(wo.metrics.tool_calls) : "-"}</td>
          <td class="num">${wo ? fmt(wo.metrics.reads) : "-"}</td>
          <td class="num">${wo ? fmt(wo.metrics.input_tokens) : "-"}</td>
          <td class="num">${wo ? fmtMs(wo.metrics.wall_ms) : "-"}</td>
        </tr>`;
  }).join("\n");

  const retros = withData.filter(d => d.retrospective);
  const retroHtml = retros.length ? `
    <div class="retro-section">
      <h3>Retrospective Feedback</h3>
      ${retros.map(rd => {
        const text = readRetro(rd.retrospective);
        return text ? `      <details><summary>Run ${rd.run}</summary>
        <pre class="retro-text">${esc(text)}</pre>
      </details>` : "";
      }).join("\n")}
    </div>` : "";

  const promptHtml = prompt ? `
    <details class="prompt-details"><summary>Task Prompt</summary>
      <pre class="prompt-text">${esc(prompt)}</pre>
    </details>` : "";

  return `
  <section class="scenario-card" id="scenario-${s}">
    <div class="scenario-header">
      <h2>${name}</h2>
      <div class="scenario-meta">
        <span class="tag">Target: ${target}</span>
        <span class="tag">${esc(promptFirstLine)}</span>
      </div>
    </div>

    <table class="comp-table">
      <thead>
        <tr>
          <th>Metric</th>
          <th class="with-col">WITH PipeMD</th>
          <th class="without-col">WITHOUT</th>
          <th>Delta</th>
          <th class="bar-header">Visual</th>
        </tr>
      </thead>
      <tbody>
${compRows}
        <tr class="quality-row">
          <td class="metric-label" style="font-weight:700">Quality Grade</td>
          <td>${qualityBadge(qW)}</td>
          <td>${qualityBadge(qWo)}</td>
          <td class="num"><span style="color:${qColor};font-weight:600">${qDelta != null ? (qDelta > 0 ? "+" : "") + qDelta : "-"}</span></td>
          <td></td>
        </tr>
        <tr class="runs-row">
          <td class="metric-label">Runs (N)</td>
          <td class="num">${sw?.n || 0}</td>
          <td class="num">${swo?.n || 0}</td>
          <td></td><td></td>
        </tr>
      </tbody>
    </table>

    <div class="verdict-box" style="--vc:${vc}">
      VERDICT: ${v.verdict}
    </div>
    <div class="verdict-detail">${v.detail}</div>
    ${v.ftDelta != null
      ? `<div class="consumption-note">
        First-turn input_tokens: WITH=${fmt(v.ftW)} WITHOUT=${fmt(v.ftWo)} (${v.ftDelta > 0 ? "+" : ""}${v.ftDelta.toFixed(0)}%)
        — unambiguous consumption signal.
      </div>`
      : `<div class="consumption-note">
        Summed input_tokens delta = ${(v.itDelta || 0).toFixed(0)}% (WITH=${fmt(v.itW)}, WITHOUT=${fmt(v.itWo)}).
        First-turn data unavailable (NDJSON files not found next to JSONL).
      </div>`}

    <details class="run-details">
      <summary>Per-Run Detail (${maxRuns} runs)</summary>
      <table class="detail-table">
        <thead>
          <tr>
            <th rowspan="2">#</th>
            <th colspan="5" class="with-col">WITH PipeMD</th>
            <th colspan="5" class="without-col">WITHOUT</th>
          </tr>
          <tr>
            <th class="with-col">Quality</th><th class="with-col">Calls</th>
            <th class="with-col">Reads</th><th class="with-col">Tokens In</th>
            <th class="with-col">Time</th>
            <th class="without-col">Quality</th><th class="without-col">Calls</th>
            <th class="without-col">Reads</th><th class="without-col">Tokens In</th>
            <th class="without-col">Time</th>
          </tr>
        </thead>
        <tbody>
${detailRows}
        </tbody>
      </table>
    </details>
${retroHtml}${promptHtml}
  </section>`;
}

// Overall summary row
function summaryRow() {
  const allWith = runs.filter(r => r.condition === "with");
  const allWithout = runs.filter(r => r.condition === "without");
  if (!allWith.length && !allWithout.length) return "";

  const sw = computeStats(allWith);
  const swo = computeStats(allWithout);
  const v = computeVerdict(sw, swo, allWith);
  const vc = verdictColor(v.verdict);

  const summaryMetrics = [
    { label: "Tool Calls", w: sw?.tc, wo: swo?.tc },
    { label: "Reads", w: sw?.r, wo: swo?.r },
    { label: "Input Tokens", w: sw?.it, wo: swo?.it, isInput: true },
    { label: "Output Tokens", w: sw?.ot, wo: swo?.ot },
    { label: "Wall Time", w: sw?.w, wo: swo?.w, fmt: fmtMs },
  ];

  const cells = summaryMetrics.map(m => {
    const wMed = m.w?.med, woMed = m.wo?.med;
    const delta = wMed != null && woMed != null && woMed > 0 ? pct(wMed, woMed) : null;
    const f = m.fmt || fmt;
    const color = delta != null
      ? deltaColor(m.isInput ? "input_tokens" : m.label.toLowerCase(), delta)
      : COLORS.gray;
    const deltaStr = delta != null
      ? `<span style="color:${color};font-weight:600">${delta > 0 ? "+" : ""}${delta.toFixed(0)}%</span>`
      : "-";
    return `<td class="num">${f(wMed)}<br><span class="delta">${deltaStr}</span></td>`;
  }).join("\n          ");

  const woCells = summaryMetrics.map(m => {
    const f = m.fmt || fmt;
    return `<td class="num">${f(m.wo?.med)}</td>`;
  }).join("\n          ");

  return `
  <section class="summary-card">
    <h2>Overall Summary</h2>
    <table class="summary-table">
      <thead>
        <tr>
          <th></th>
          <th colspan="5" class="with-col">WITH PipeMD (median)</th>
          <th colspan="5" class="without-col">WITHOUT (median)</th>
        </tr>
        <tr>
          <th>Condition</th>
          <th class="with-col">Calls</th><th class="with-col">Reads</th>
          <th class="with-col">Tokens In</th><th class="with-col">Tokens Out</th>
          <th class="with-col">Time</th>
          <th class="without-col">Calls</th><th class="without-col">Reads</th>
          <th class="without-col">Tokens In</th><th class="without-col">Tokens Out</th>
          <th class="without-col">Time</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="metric-label" style="font-weight:700">All Scenarios</td>
          ${cells}
          ${woCells}
        </tr>
      </tbody>
    </table>
    <div class="verdict-box" style="--vc:${vc}">
      VERDICT: ${v.verdict}
    </div>
    <div class="verdict-detail">${v.detail}</div>
    <div class="summary-note">
      ${runs.length} total runs across ${scenarios.length} scenarios.
      Per-scenario verdicts below may differ from this aggregate.
    </div>
  </section>`;
}

const scenarioCards = scenarios.map(s => scenarioCard(s)).join("\n");

const rawJsonl = lines.map(esc).join("\n");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PipeMD Bench Report — ${meta.timestamp}</title>
  <style>
    :root {
      --bg: ${COLORS.bg}; --card: ${COLORS.card}; --border: ${COLORS.border};
      --text: ${COLORS.text}; --dim: ${COLORS.dim};
      --with: ${COLORS.withCol}; --without: ${COLORS.withoutCol};
    }
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.6;
      padding: 24px; max-width: 1200px; margin: 0 auto;
    }
    h1 { font-size: 28px; margin-bottom: 4px; letter-spacing: -0.5px; }
    h2 { font-size: 20px; margin-bottom: 12px; letter-spacing: -0.3px; }
    h3 { font-size: 15px; margin-bottom: 8px; color: var(--dim); }

    /* Header */
    .header { margin-bottom: 32px; border-bottom: 1px solid var(--border); padding-bottom: 20px; }
    .header-meta { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
    .header-meta span {
      font-size: 13px; color: var(--dim); background: var(--card);
      padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border);
    }

    /* Cards */
    .summary-card, .scenario-card, .methodology-card, .raw-section {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 12px; padding: 24px; margin-bottom: 24px;
    }
    .scenario-header { margin-bottom: 20px; }
    .scenario-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    .tag {
      font-size: 12px; color: var(--dim); background: var(--bg);
      padding: 3px 10px; border-radius: 4px; max-width: 600px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* Tables */
    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left; padding: 8px 12px; color: var(--dim);
      font-weight: 600; font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.5px; border-bottom: 1px solid var(--border);
    }
    td { padding: 6px 12px; border-bottom: 1px solid #1e293b; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .metric-label { font-weight: 500; color: var(--dim); white-space: nowrap; }
    .range { color: #475569; font-size: 11px; }
    .delta { font-size: 11px; }
    .with-col { color: var(--with); }
    .without-col { color: var(--without); }
    th.with-col, th.without-col { text-align: center; }

    /* Comparison table */
    .comp-table { font-size: 13px; margin-bottom: 16px; }
    .comp-table th { font-size: 11px; }
    .comp-table .bar-header { text-align: center; }
    .bar-cell { text-align: center; vertical-align: middle; }
    .bar-svg { display: inline-block; vertical-align: middle; }
    .quality-row { border-top: 2px solid var(--border); }
    .runs-row { opacity: 0.5; }

    /* Summary table */
    .summary-table { font-size: 14px; margin-bottom: 16px; }
    .summary-note { font-size: 12px; color: #475569; margin-top: 8px; font-style: italic; }

    /* Detail table */
    .detail-table { font-size: 12px; }
    .detail-table th { font-size: 10px; }
    .run-num { color: var(--dim); text-align: center; }
    .divider { border-left: 2px solid var(--border); }

    /* Quality badge */
    .qbadge {
      display: inline-block; padding: 2px 10px; border-radius: 9999px;
      font-size: 11px; font-weight: 600;
      background: color-mix(in srgb, var(--c) 15%, transparent);
      color: var(--c);
      border: 1px solid color-mix(in srgb, var(--c) 30%, transparent);
    }

    /* Verdict */
    .verdict-box {
      display: inline-block; margin-top: 16px; padding: 10px 20px;
      border-radius: 8px; font-weight: 700; font-size: 15px;
      background: color-mix(in srgb, var(--vc) 15%, transparent);
      color: var(--vc);
      border: 1px solid color-mix(in srgb, var(--vc) 30%, transparent);
    }
    .verdict-detail { font-size: 13px; color: var(--dim); margin-top: 6px; }
    .consumption-note { font-size: 12px; color: #475569; margin-top: 4px; font-style: italic; }

    /* Collapsibles */
    details { margin-top: 4px; }
    summary {
      cursor: pointer; color: var(--dim); font-size: 13px; padding: 6px 0;
      list-style: none;
    }
    summary::before { content: "▸ "; }
    details[open] summary::before { content: "▾ "; }
    summary:hover { color: var(--text); }
    .retro-section { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px; }
    .retro-section summary { color: var(--with); }
    .retro-text, .prompt-text {
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      padding: 14px; font-size: 12px; overflow-x: auto; margin-top: 8px;
      white-space: pre-wrap; color: var(--text); max-height: 300px; overflow-y: auto;
    }
    .prompt-details { margin-top: 12px; }

    /* Methodology */
    .meth-table { font-size: 13px; }
    .meth-label { font-weight: 600; color: var(--dim); white-space: nowrap; width: 160px; }

    /* Raw data */
    .raw-section pre {
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      padding: 14px; font-size: 11px; overflow-x: auto; margin-top: 8px;
      max-height: 400px; overflow-y: auto; color: var(--dim);
    }

    /* Footer */
    footer { text-align: center; color: #334155; font-size: 11px; padding: 24px 0; }
  </style>
</head>
<body>

  <header class="header">
    <h1>PipeMD Agent A/B Benchmark</h1>
    <div class="header-meta">
      <span>Model: ${meta.model}</span>
      <span>Runs/cell: ${meta.runs_per_cell}</span>
      <span>Timestamp: ${meta.timestamp}</span>
      <span>Scenarios: ${scenarios.length}</span>
      <span>Total runs: ${runs.length}${voidRuns.length ? ` (${voidRuns.length} void — excluded)` : ""}</span>
    </div>
  </header>

${summaryRow()}
${scenarioCards}

  <section class="methodology-card">
    <h2>Methodology</h2>
    <table class="meth-table">
      <tr><td class="meth-label">Quality-First Rule</td><td>Efficiency metrics are only compared between runs at the same quality grade. Fast-but-broken does not beat slow-but-correct.</td></tr>
      <tr><td class="meth-label">Consumption Signal</td><td>AGENTS.md is auto-loaded into the system prompt at session start. Consumption is detected via input_tokens(WITH) &gt; input_tokens(WITHOUT), not read tool-calls.</td></tr>
      <tr><td class="meth-label">First-Turn Note</td><td>Summed input_tokens is confounded by turn count. For calibration, check the first turn in raw NDJSON — WITH should be ~5k tokens higher than WITHOUT.</td></tr>
      <tr><td class="meth-label">Delivery Mode</td><td>Legacy/file mode forced for bench (not FIFO). AGENTS.md is a real file on disk, rendered by the daemon before the agent starts.</td></tr>
      <tr><td class="meth-label">Render Timeout</td><td>Daemon has 60s to render AGENTS.md. Failed renders mark the cell VOID and exclude it from analysis.</td></tr>
      <tr><td class="meth-label">Context Tax</td><td>input_tokens will be HIGHER with PipeMD (the context costs tokens). The value hypothesis: output_tokens, tool_calls, reads, and wall_ms should be LOWER.</td></tr>
    </table>
  </section>

  <section class="raw-section">
    <details><summary>Raw Data (JSONL)</summary>
      <pre>${rawJsonl}</pre>
    </details>
  </section>

  <footer>
    Generated by bench/report-html.sh &mdash; PipeMD Benchmark Suite
  </footer>

</body>
</html>`;

writeFileSync(output, html);
console.log("Report written to " + output);
