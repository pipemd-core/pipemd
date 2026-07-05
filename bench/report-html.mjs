/* global process, console */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, isAbsolute, dirname } from "node:path";

const [input, output, repoRoot, scenarioNamesRaw, scenarioTargetsRaw, promptsDir] = process.argv.slice(2);

const scenarioNamesFallback = JSON.parse(scenarioNamesRaw);
const scenarioTargetsFallback = JSON.parse(scenarioTargetsRaw);
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
    inj: stat(m => m.injections_delivered || 0),
    rw: stat(m => m.rework || 0), ufe: stat(m => m.unique_files_edited || 0),
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
  dim: "#94a3b8", withCol: "#60a5fa", staticCol: "#fb923c",
  green: "#22c55e", yellow: "#f59e0b", red: "#ef4444", gray: "#6b7280",
  passiveCol: "#a78bfa",
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

function svgBar(withVal, passiveVal, staticVal, maxVal) {
  const W = 200, H = 14, gap = 2;
  const vals = [withVal, passiveVal, staticVal].filter(v => v != null);
  maxVal = Math.max(...vals, maxVal || 0, 1);
  const wW = withVal != null ? Math.max(3, (withVal / maxVal) * W) : 0;
  const pW = passiveVal != null ? Math.max(3, (passiveVal / maxVal) * W) : 0;
  const woW = staticVal != null ? Math.max(3, (staticVal / maxVal) * W) : 0;
  const totalH = H * 3 + gap * 2;
  return `<svg class="bar-svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">
    <rect x="0" y="0" width="${wW}" height="${H}" rx="3" fill="${COLORS.withCol}" opacity="0.75"/>
    <rect x="0" y="${H + gap}" width="${pW}" height="${H}" rx="3" fill="${COLORS.passiveCol}" opacity="0.75"/>
    <rect x="0" y="${(H + gap) * 2}" width="${woW}" height="${H}" rx="3" fill="${COLORS.staticCol}" opacity="0.75"/>
  </svg>`;
}

const TOKEN_GUARD_PCT = 100;

function computeVerdict(sw, swo, withData) {
  const callsW = sw?.tc?.med || 0;
  const callsWo = swo?.tc?.med || 0;
  const readsW = sw?.r?.med || 0;
  const readsWo = swo?.r?.med || 0;
  const wallW = sw?.w?.med || 0;
  const wallWo = swo?.w?.med || 0;
  const itW = sw?.it?.med || 0;
  const itWo = swo?.it?.med || 0;
  const qW = sw?.q, qWo = swo?.q;

  const consumed = withData.some(d => (d.metrics.injections_delivered || 0) > 0);
  const fewerCalls = callsWo > 0 && callsW < callsWo;
  const fewerReads = readsWo > 0 && readsW < readsWo;
  const faster = wallWo > 0 && wallW < wallWo;
  const wins = [fewerCalls, fewerReads, faster].filter(Boolean).length;

  const callsDelta = callsWo > 0 ? pct(callsW, callsWo) : 0;
  const readsDelta = readsWo > 0 ? pct(readsW, readsWo) : 0;
  const wallDelta = wallWo > 0 ? pct(wallW, wallWo) : 0;
  const tokDelta = itWo > 0 ? pct(itW, itWo) : 0;
  const sig = `calls ${callsDelta.toFixed(0)}%, reads ${readsDelta.toFixed(0)}%, wall ${wallDelta.toFixed(0)}%, tokens ${tokDelta.toFixed(0)}%`;

  let verdict, detail;
  if (!consumed && withData.length > 0) {
    verdict = "VOID"; detail = "No injections delivered";
  } else if (qW != null && qWo != null && qW !== qWo) {
    verdict = "INCONCLUSIVE"; detail = `Quality differs (${qW} vs ${qWo})`;
  } else if (tokDelta > TOKEN_GUARD_PCT) {
    verdict = "INCONCLUSIVE"; detail = `Token regression caps verdict (WITH +${tokDelta.toFixed(0)}% input tokens vs STATIC) — ${sig}`;
  } else if (wins >= 2) {
    verdict = "PASS"; detail = `Equal quality, ${wins}/3 efficiency wins (${sig})`;
  } else if (wins === 1) {
    verdict = "WEAK"; detail = `Equal quality, 1/3 efficiency wins (${sig})`;
  } else {
    verdict = "INCONCLUSIVE"; detail = `No efficiency improvement (${sig})`;
  }
  return { verdict, detail, consumed, callsDelta, readsDelta, wallDelta, tokDelta };
}

const metricsDef = [
  { key: "tc", label: "Tool Calls", fn: m => m.tool_calls, lower: true },
  { key: "r", label: "Reads", fn: m => m.reads, lower: true },
  { key: "e", label: "Edits", fn: m => m.edits, lower: true },
  { key: "rw", label: "Rework (re-edits)", fn: m => m.rework || 0, lower: true },
  { key: "ufe", label: "Files Edited", fn: m => m.unique_files_edited || 0, lower: false },
  { key: "it", label: "Input Tokens", fn: m => m.input_tokens, lower: false },
  { key: "ot", label: "Output Tokens", fn: m => m.output_tokens, lower: true },
  { key: "w", label: "Wall Time", fn: m => m.wall_ms, fmt: fmtMs, lower: true },
  { key: "inj", label: "Injections", fn: m => m.injections_delivered || 0, lower: false },
];

function verdictColor(v) {
  return { PASS: COLORS.green, WEAK: COLORS.yellow, VOID: COLORS.red, INCONCLUSIVE: COLORS.gray }[v] || COLORS.gray;
}

function scenarioCard(s) {
  const withData = groups[`${s}-with`] || [];
  const passiveData = groups[`${s}-passive`] || [];
  const staticData = groups[`${s}-static`] || [];
  const sw = computeStats(withData);
  const sp = computeStats(passiveData);
  const swo = computeStats(staticData);
  const name = scenarioNames[s] || `Scenario ${s}`;
  const target = scenarioTargets[s] || "?";
  const prompt = readPrompt(s);
  const promptFirstLine = prompt ? prompt.split("\n")[0] : "";
  const v = computeVerdict(sw, swo, withData);
  const vc = verdictColor(v.verdict);
  const maxRuns = Math.max(withData.length, passiveData.length, staticData.length);

  const compRows = metricsDef.map(md => {
    const wv = sw?.[md.key], pv = sp?.[md.key], wov = swo?.[md.key];
    const wMed = wv?.med, pMed = pv?.med, woMed = wov?.med;
    const deltaWo = wMed != null && woMed != null && woMed > 0 ? pct(wMed, woMed) : null;
    const deltaP = wMed != null && pMed != null && pMed > 0 ? pct(wMed, pMed) : null;
    const isInput = md.key === "it";
    const f = md.fmt || fmt;
    const fmtRange = (v) => v?.med != null ? `${f(v.med)} <span class="range">(${f(v.min)}–${f(v.max)})</span>` : "-";
    const deltaColorWo = deltaWo != null ? deltaColor(isInput ? "input_tokens" : md.key, deltaWo) : COLORS.gray;
    const deltaColorP = deltaP != null ? deltaColor(isInput ? "input_tokens" : md.key, deltaP) : COLORS.gray;
    const bar = svgBar(wMed, pMed, woMed, null);
    return `      <tr>
        <td class="metric-label">${md.label}</td>
        <td class="num">${fmtRange(wv)}</td>
        <td class="num passive-col">${fmtRange(pv)}</td>
        <td class="num">${fmtRange(wov)}</td>
        <td class="num">${deltaWo != null ? `<span style="color:${deltaColorWo};font-weight:600">${deltaWo > 0 ? "+" : ""}${deltaWo.toFixed(0)}%</span>` : "-"}</td>
        <td class="num">${deltaP != null ? `<span style="color:${deltaColorP};font-weight:600">${deltaP > 0 ? "+" : ""}${deltaP.toFixed(0)}%</span>` : "-"}</td>
        <td class="bar-cell">${bar}</td>
      </tr>`;
  }).join("\n");

  const qW = sw?.q, qP = sp?.q, qWo = swo?.q;

  const detailRows = Array.from({ length: maxRuns }, (_, i) => {
    const w = withData[i], p = passiveData[i], wo = staticData[i];
    return `        <tr>
          <td class="run-num">${i + 1}</td>
          <td>${qualityBadge(w?.quality)}</td>
          <td class="num">${w ? fmt(w.metrics.tool_calls) : "-"}</td>
          <td class="num">${w ? fmt(w.metrics.reads) : "-"}</td>
          <td class="num">${w ? fmt(w.metrics.input_tokens) : "-"}</td>
          <td class="num">${w ? fmtMs(w.metrics.wall_ms) : "-"}</td>
          <td class="divider">${qualityBadge(p?.quality)}</td>
          <td class="num">${p ? fmt(p.metrics.tool_calls) : "-"}</td>
          <td class="num">${p ? fmt(p.metrics.reads) : "-"}</td>
          <td class="num">${p ? fmt(p.metrics.input_tokens) : "-"}</td>
          <td class="num">${p ? fmtMs(p.metrics.wall_ms) : "-"}</td>
          <td class="divider">${qualityBadge(wo?.quality)}</td>
          <td class="num">${wo ? fmt(wo.metrics.tool_calls) : "-"}</td>
          <td class="num">${wo ? fmt(wo.metrics.reads) : "-"}</td>
          <td class="num">${wo ? fmt(wo.metrics.input_tokens) : "-"}</td>
          <td class="num">${wo ? fmtMs(wo.metrics.wall_ms) : "-"}</td>
        </tr>`;
  }).join("\n");

  const retros = [...withData, ...passiveData].filter(d => d.retrospective);
  const retroHtml = retros.length ? `
    <div class="retro-section">
      <h3>Retrospective Feedback</h3>
      ${retros.map(rd => {
        const text = readRetro(rd.retrospective);
        return text ? `      <details><summary>s${rd.scenario}-${rd.condition}-r${rd.run}</summary>
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
          <th class="with-col">WITH</th>
          <th class="passive-col">PASSIVE</th>
          <th class="static-col">STATIC</th>
          <th>W vs WO</th>
          <th>W vs P</th>
          <th class="bar-header">Visual</th>
        </tr>
      </thead>
      <tbody>
${compRows}
        <tr class="quality-row">
          <td class="metric-label" style="font-weight:700">Quality Grade</td>
          <td>${qualityBadge(qW)}</td>
          <td class="passive-col">${qualityBadge(qP)}</td>
          <td>${qualityBadge(qWo)}</td>
          <td></td><td></td><td></td>
        </tr>
        <tr class="runs-row">
          <td class="metric-label">Valid runs (N)</td>
          <td class="num">${sw?.n || 0}</td>
          <td class="num passive-col">${sp?.n || 0}</td>
          <td class="num">${swo?.n || 0}</td>
          <td></td><td></td><td></td>
        </tr>
      </tbody>
    </table>

    <div class="verdict-box" style="--vc:${vc}">
      WITH vs STATIC: ${v.verdict}
    </div>
    <div class="verdict-detail">${v.detail}</div>

    <details class="run-details">
      <summary>Per-Run Detail (${maxRuns} runs)</summary>
      <div class="detail-table-container">
      <table class="detail-table">
        <thead>
          <tr>
            <th rowspan="2">#</th>
            <th colspan="5" class="with-col">WITH</th>
            <th colspan="5" class="passive-col">PASSIVE</th>
            <th colspan="5" class="static-col">STATIC</th>
          </tr>
          <tr>
            <th class="with-col">Q</th><th class="with-col">Calls</th>
            <th class="with-col">Reads</th><th class="with-col">Tokens</th>
            <th class="with-col">Time</th>
            <th class="passive-col">Q</th><th class="passive-col">Calls</th>
            <th class="passive-col">Reads</th><th class="passive-col">Tokens</th>
            <th class="passive-col">Time</th>
            <th class="static-col">Q</th><th class="static-col">Calls</th>
            <th class="static-col">Reads</th><th class="static-col">Tokens</th>
            <th class="static-col">Time</th>
          </tr>
        </thead>
        <tbody>
${detailRows}
        </tbody>
      </table>
      </div>
    </details>
${retroHtml}${promptHtml}
  </section>`;
}

// Overall summary row
function summaryRow() {
  const allWith = runs.filter(r => r.condition === "with");
  const allPassive = runs.filter(r => r.condition === "passive");
  const allStatic = runs.filter(r => r.condition === "static");
  if (!allWith.length && !allStatic.length) return "";

  const sw = computeStats(allWith);
  const sp = computeStats(allPassive);
  const swo = computeStats(allStatic);
  const v = computeVerdict(sw, swo, allWith);
  const vc = verdictColor(v.verdict);

  const metrics = ["tc", "r", "rw", "it", "ot", "w"];

  const fmtCell = (stat, key) => {
    const val = stat?.[key]?.med;
    if (val == null) return '<td class="num">-</td>';
    const f = key === "w" ? fmtMs : fmt;
    return `<td class="num">${f(val)}</td>`;
  };

  const wCells = metrics.map(k => fmtCell(sw, k)).join("\n          ");
  const pCells = metrics.map(k => fmtCell(sp, k)).join("\n          ");
  const woCells = metrics.map(k => fmtCell(swo, k)).join("\n          ");

  return `
  <section class="summary-card">
    <h2>Overall Summary</h2>
    <table class="summary-table">
      <thead>
        <tr>
          <th></th>
          <th colspan="6" class="with-col">WITH (median)</th>
          <th colspan="6" class="passive-col">PASSIVE (median)</th>
          <th colspan="6" class="static-col">STATIC (median)</th>
        </tr>
        <tr>
          <th>Condition</th>
          <th class="with-col">Calls</th><th class="with-col">Reads</th>
          <th class="with-col">Rework</th>
          <th class="with-col">Tokens In</th><th class="with-col">Tokens Out</th>
          <th class="with-col">Time</th>
          <th class="passive-col">Calls</th><th class="passive-col">Reads</th>
          <th class="passive-col">Rework</th>
          <th class="passive-col">Tokens In</th><th class="passive-col">Tokens Out</th>
          <th class="passive-col">Time</th>
          <th class="static-col">Calls</th><th class="static-col">Reads</th>
          <th class="static-col">Rework</th>
          <th class="static-col">Tokens In</th><th class="static-col">Tokens Out</th>
          <th class="static-col">Time</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="metric-label" style="font-weight:700">All Scenarios</td>
          ${wCells}
          ${pCells}
          ${woCells}
        </tr>
      </tbody>
    </table>
    <div class="verdict-box" style="--vc:${vc}">
      WITH vs STATIC: ${v.verdict}
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
      --with: ${COLORS.withCol}; --static: ${COLORS.staticCol}; --passive: ${COLORS.passiveCol};
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
    .static-col { color: var(--static); }
    .passive-col { color: var(--passive); }
    th.with-col, th.static-col, th.passive-col { text-align: center; }

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
    .detail-table-container { overflow-x: auto; }
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
      <tr><td class="meth-label">Consumption Signal</td><td>AGENTS.md is auto-loaded into the system prompt at session start. Consumption is verified via injections_delivered > 0, not token overhead.</td></tr>
      <tr><td class="meth-label">Verdict Logic</td><td>PASS = equal quality AND ≥2 of {fewer tool calls, fewer reads, faster wall time}. WEAK = 1 of 3. INCONCLUSIVE = 0 of 3, quality differs, OR token regression > ${TOKEN_GUARD_PCT}% (WITH using >2× STATIC's input tokens caps the verdict — a win that costs 2× the tokens isn't a win).</td></tr>
      <tr><td class="meth-label">3-Condition Design</td><td>WITH = daemon + plugin + live injection. PASSIVE = a single rendered snapshot, daemon then killed (frozen). STATIC = a hand-written-style AGENTS.md with NO pmd blocks — the realistic control (a normal project's static context file). <b>WITH vs STATIC</b> answers the product question: does dynamic injection beat a normal static AGENTS.md? <b>PASSIVE vs STATIC</b>: is a frozen pmd snapshot worth more than a hand-written file? <b>WITH vs PASSIVE</b>: does live injection earn its keep over a frozen snapshot?</td></tr>
      <tr><td class="meth-label">Multi-ecosystem</td><td>Scenarios span TypeScript (Hono), Lua (bt-lua), Python (cachetools), Go (gofrs/uuid). Each task is middle-length and graded by a NATIVE gate (tsc+vitest / lua / pytest+ruff / go test+gofmt) — never a grep.</td></tr>
      <tr><td class="meth-label">Delivery Mode</td><td>Legacy/file mode forced for bench (not FIFO). AGENTS.md is a real file on disk, rendered by the daemon before the agent starts.</td></tr>
      <tr><td class="meth-label">Render Timeout</td><td>Daemon has 60s to render AGENTS.md. Failed renders mark the cell VOID and exclude it from analysis.</td></tr>
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
