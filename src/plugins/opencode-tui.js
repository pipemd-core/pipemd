// pmd-crew-tui — PipeMD sidebar panel for OpenCode.
// Installed by `pmd crew install-hooks`. Safe to delete manually.
// @pmd-plugin-version ${PLUGIN_VERSION}
//
// Renders into the right sidebar showing:
//   PipeMD status, crew sessions, hook log, stats.
import { createElement as el, createTextNode as txt, spread, insert, useKeyboard } from "@opentui/solid";
import { createSignal, createMemo, createEffect, onCleanup } from "solid-js";
import { RGBA } from "@opentui/core";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const PROJECT_ROOT = resolve(dirname(import.meta.url.replace("file://", "")), "..");
const STATS_PATH = join(PROJECT_ROOT, ".pipemd", ".tui-stats.json");
const STATUS_PATH = join(PROJECT_ROOT, ".pipemd", ".status.json");
const CREW_STATUS_PATH = join(PROJECT_ROOT, ".pipemd", ".crew-status.json");
const DASHBOARD_PATH = join(PROJECT_ROOT, ".pipemd", ".dashboard.json");
const CREW_STATUS_STALE_MS = 90000;
const CREW_DIR = join(PROJECT_ROOT, ".pipemd", "crew");
const PID_PATH = join(PROJECT_ROOT, ".pipemd", ".daemon.pid");
const INJECT_LOG_DIR = join(PROJECT_ROOT, ".pipemd", ".injection-log");
const ERROR_LOG_PATH = join(PROJECT_ROOT, ".pipemd", ".plugin-errors.log");
const CONTEXT_FILES = ["AGENTS.md", "AI_CONTEXT.md"];
const POLL_MS = 2000;
const MAX_SESSIONS = 20;
const SIDEBAR_EVENT_CAP = 10;

function estimateTokens(bytes) {
  return Math.round(bytes / 4);
}

function formatTokenCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function formatBytes(b) {
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + "MB";
  if (b >= 1024) return (b / 1024).toFixed(1) + "KB";
  return b + "B";
}

function findContextSize() {
  try {
    const st = JSON.parse(readFileSync(STATUS_PATH, "utf-8"));
    if (st && typeof st.renderedBytes === "number" && st.renderedBytes > 0) {
      return { bytes: st.renderedBytes };
    }
  } catch {}
  for (const f of CONTEXT_FILES) {
    try { const s = statSync(f); if (s.isFile() && s.size > 0) return { bytes: s.size }; } catch {}
  }
  return null;
}

function tryReadJson(p) {
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

function tryReadPid() {
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    if (pid > 0) { try { process.kill(pid, 0); return pid; } catch (e) { return e.code === "EPERM" ? pid : null; } }
  } catch {}
  return null;
}

let savedRoute = null;

function readSessions() {
  try {
    return readdirSync(CREW_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => { try { return JSON.parse(readFileSync(join(CREW_DIR, f), "utf-8")); } catch { return null; } })
      .filter((s) => s && s.id);
  } catch { return []; }
}

function findConflicts(sessions) {
  const byPath = new Map();
  for (const s of sessions) {
    for (const c of (s.claimedFiles || [])) {
      const set = byPath.get(c.path) || new Set();
      set.add(s.id);
      byPath.set(c.path, set);
    }
  }
  const out = [];
  for (const [p, set] of byPath) { if (set.size > 1) out.push({ path: p, sessionIds: [...set] }); }
  return out;
}

function readLastError() {
  try {
    const raw = readFileSync(ERROR_LOG_PATH, "utf-8").split("\n").filter(Boolean);
    if (raw.length === 0) return null;
    const last = JSON.parse(raw[raw.length - 1]);
    if (last && typeof last.ts === "number" && Date.now() - last.ts < 300000) {
      return last;
    }
  } catch {}
  return null;
}

function formatTimeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 5) return "now";
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h";
}

function formatGap(seconds) {
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m" + (seconds % 60 ? " " + (seconds % 60) + "s" : "");
  return Math.floor(seconds / 3600) + "h" + (Math.floor((seconds % 3600) / 60) ? " " + Math.floor((seconds % 3600) / 60) + "m" : "");
}

function truncStr(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

function basename(p) {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function eventKey(e) {
  return (e.ts || "") + ":" + (e.trigger || "") + ":" + (e.result || "");
}

function vbox(children, props) {
  const box = el("box");
  spread(box, { flexDirection: "column", gap: 0, ...props });
  for (const c of children) { if (c) insert(box, c); }
  return box;
}

function hbox(children, props) {
  const box = el("box");
  spread(box, { flexDirection: "row", gap: 1, ...props });
  for (const c of children) { if (c) insert(box, c); }
  return box;
}

function textNode(content, fg) {
  const t = el("text");
  spread(t, fg ? { fg } : {});
  insert(t, txt(String(content)));
  return t;
}

function boldNode(content, fg) {
  const b = el("b");
  insert(b, txt(String(content)));
  const t = el("text");
  spread(t, fg ? { fg } : {});
  insert(t, b);
  return t;
}

function dot(color) {
  const t = el("text");
  spread(t, { fg: color });
  insert(t, txt("\u25CF"));
  return t;
}

function renderTraceRoute(api) {
  const theme = () => api.theme.current;
  const [tick, setTick] = createSignal(Date.now());
  const [view, setView] = createSignal("timeline");
  const [cursor, setCursor] = createSignal(0);
  const [scrollOffset, setScrollOffset] = createSignal(0);
  const [expandedKey, setExpandedKey] = createSignal(null);
  const timer = setInterval(() => setTick(Date.now()), POLL_MS);
  onCleanup(() => clearInterval(timer));

  const stats = createMemo(() => { tick(); return tryReadJson(STATS_PATH); });
  const sessions = createMemo(() => { tick(); return readSessions(); });
  const daemonPid = createMemo(() => { tick(); return tryReadPid(); });
  const allEvents = createMemo(() => (stats()?.events || []).slice().reverse());
  const conflictList = createMemo(() => findConflicts(sessions()));
  const dashboard = createMemo(() => { tick(); return tryReadJson(DASHBOARD_PATH); });
  const passiveAgents = createMemo(() => {
    const db = dashboard();
    if (db && db.crew && Array.isArray(db.crew.passiveAgents)
        && typeof db.ts === "number" && Date.now() - db.ts < 30000) {
      return db.crew.passiveAgents.slice(0, 8);
    }
    const raw = stats()?.passiveAgents || [];
    return raw.slice(0, 8);
  });

  const h = () => process.stdout.rows || 24;
  const footerLines = 2;
  const visibleRows = () => h() - footerLines;

  const dismissTrace = () => {
    const prev = savedRoute;
    savedRoute = null;
    if (prev && prev.name === "session" && prev.params && prev.params.sessionID) {
      api.route.navigate("session", { sessionID: prev.params.sessionID });
    } else {
      api.route.navigate("home");
    }
  };

  useKeyboard((evt) => {
    if (api.route.current.name !== "pmd-trace") return;
    if (evt.name === "escape" || (evt.alt && evt.name === "p")) {
      evt.preventDefault();
      evt.stopPropagation();
      if (expandedKey()) { setExpandedKey(null); return; }
      dismissTrace();
      return;
    }
    const evts = allEvents();
    const total = view() === "tree" ? sessions().length : evts.length;
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault();
      evt.stopPropagation();
      setCursor(Math.max(0, cursor() - 1));
    } else if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault();
      evt.stopPropagation();
      setCursor(Math.min(total - 1, cursor() + 1));
    } else if (evt.name === "enter") {
      evt.preventDefault();
      evt.stopPropagation();
      if (view() === "timeline") {
        const idx = cursor();
        if (idx >= 0 && idx < evts.length && evts[idx].result === "injected") {
          const key = eventKey(evts[idx]);
          setExpandedKey((prev) => prev === key ? null : key);
        }
      }
    } else if (evt.name === "right" || evt.name === "l") {
      const views = ["tree", "timeline", "locks"];
      const next = (views.indexOf(view()) + 1) % views.length;
      setView(views[next]); setCursor(0); setScrollOffset(0); setExpandedKey(null);
    } else if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault(); evt.stopPropagation();
      const views = ["tree", "timeline", "locks"];
      const prev = (views.indexOf(view()) - 1 + views.length) % views.length;
      setView(views[prev]); setCursor(0); setScrollOffset(0); setExpandedKey(null);
    }
  });

  const root = el("box");
  spread(root, {
    position: "absolute",
    zIndex: 3000,
    left: 0,
    top: 0,
    width: process.stdout.columns || 80,
    height: h(),
    backgroundColor: RGBA.fromInts(0, 0, 0, 220),
  });

  const panel = el("box");
  spread(panel, {
    flexDirection: "column",
    width: Math.min((process.stdout.columns || 80) - 4, 120),
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 1,
    gap: 0,
  });
  insert(root, panel);

  insert(panel, () => {
    tick();
    view();
    cursor();
    scrollOffset();
    expandedKey();
    const sess = sessions();
    const evts = allEvents();
    const dPid = daemonPid();
    const conflicts = conflictList();
    const pAgents = passiveAgents();
    const pw = Math.min((process.stdout.columns || 80) - 8, 114);
    const th = theme();
    const ek = expandedKey();

    const coordSessions = sess.filter((s) => s.role !== "worker");
    const workerByCoord = new Map();
    for (const s of sess) {
      if (s.role === "worker" && s.coordinatorId) {
        const list = workerByCoord.get(s.coordinatorId) || [];
        list.push(s);
        workerByCoord.set(s.coordinatorId, list);
      }
    }

    // ══ HEADER ══
    const header = [];

    const injectedCount = evts.filter((e) => e.result === "injected").length;
    const totalInjected = evts.reduce((s, e) => s + (e.tokens || 0), 0);

    header.push(hbox([
      boldNode("PipeMD Trace", th.primary),
      textNode("\u00B7", th.textMuted),
      textNode(sess.length + " sess", th.text),
      textNode("\u00B7", th.textMuted),
      textNode(dPid ? "live" : "offline", dPid ? th.success : th.error),
      textNode("\u00B7", th.textMuted),
      textNode(evts.length + " events", th.textMuted),
    ], { gap: 1 }));

    if (totalInjected > 0) {
      header.push(hbox([
        boldNode(formatTokenCount(estimateTokens(totalInjected)) + " tok", th.primary),
        textNode("injected \u00B7 " + injectedCount + " events", th.textMuted),
      ], { gap: 1, paddingLeft: 1 }));
    }

    header.push(hbox([
      textNode(view() === "tree" ? "\u25B6 tree" : "  tree", view() === "tree" ? th.primary : th.textMuted),
      textNode(view() === "timeline" ? "\u25B6 timeline" : "  timeline", view() === "timeline" ? th.primary : th.textMuted),
      textNode(view() === "locks" ? "\u25B6 locks" : "  locks", view() === "locks" ? th.primary : th.textMuted),
    ], { gap: 2 }));

    header.push(textNode("\u2500".repeat(pw), RGBA.fromInts(60, 60, 60, 255)));

    // Agent status
    const activeCount = sess.length;
    const passiveCount = pAgents.length;
    const totalAgents = activeCount + passiveCount;

    if (totalAgents > 0) {
      header.push(hbox([
        boldNode("Agents", th.text),
        dot(th.success),
        textNode(activeCount + " active", th.success),
        passiveCount > 0 ? dot(th.warning) : textNode("", th.textMuted),
        passiveCount > 0 ? textNode(passiveCount + " passive", th.warning) : textNode("", th.textMuted),
      ], { gap: 1 }));

      for (const c of coordSessions) {
        const claimed = (c.claimedFiles || []).map((cl) => cl.path).join(", ");
        header.push(hbox([
          dot(th.success),
          textNode(truncStr(c.harness, 14), th.text),
          textNode("coord", th.textMuted),
        ], { gap: 1, paddingLeft: 1 }));
        if (claimed) {
          header.push(textNode("  claimed: " + truncStr(claimed, pw - 16), th.textMuted));
        }
        const workers = workerByCoord.get(c.id) || [];
        for (let wi = 0; wi < workers.length; wi++) {
          const w = workers[wi];
          const prefix = wi === workers.length - 1 ? "\u2514\u2500" : "\u251C\u2500";
          const wLabel = w.label ? truncStr(w.label, 16) : truncStr(w.id, 10);
          header.push(hbox([
            textNode(prefix, th.textMuted),
            dot(th.primary),
            textNode(truncStr(w.harness || "worker", 12), th.text),
            textNode(wLabel, th.textMuted),
          ], { gap: 1, paddingLeft: 2 }));
        }
      }
      const unattached = sess.filter((s) => s.role === "worker" && !s.coordinatorId);
      for (const w of unattached) {
        header.push(hbox([
          dot(th.warning),
          textNode(truncStr(w.harness || "worker", 12), th.text),
          textNode("worker", th.textMuted),
        ], { gap: 1, paddingLeft: 1 }));
      }
      for (const pa of pAgents) {
        header.push(hbox([
          dot(th.warning),
          textNode(truncStr(pa, pw - 6), th.textMuted),
        ], { gap: 1, paddingLeft: 1 }));
      }
    } else {
      header.push(textNode("No active agents", th.textMuted));
    }

    header.push(textNode("\u2500".repeat(pw), RGBA.fromInts(60, 60, 60, 255)));

    const headerLineCount = header.length;

    // ══ BODY ROWS ══
    const rows = [];

    if (view() === "tree") {
      for (const c of coordSessions) {
        const hb = c.lastHeartbeat ? formatTimeAgo(c.lastHeartbeat) : "?";
        const claimed = (c.claimedFiles || []).map((cl) => cl.path).join(", ");
        rows.push(hbox([
          textNode("\u25CF", th.success),
          textNode(truncStr(c.harness, 14), th.text),
          textNode(truncStr(c.id, 8), th.textMuted),
          textNode("pid:" + (c.pid || "?"), th.textMuted),
          textNode(hb, th.textMuted),
        ], { gap: 1, paddingLeft: 1 }));
        if (claimed) rows.push(textNode("  claimed: " + truncStr(claimed, pw - 16), th.textMuted));
        const workers = workerByCoord.get(c.id) || [];
        for (let wi = 0; wi < workers.length; wi++) {
          const wk = workers[wi];
          const prefix = wi === workers.length - 1 ? "\u2514\u2500" : "\u251C\u2500";
          rows.push(hbox([
            textNode(prefix, th.textMuted),
            textNode("\u25CB", th.primary),
            textNode(truncStr(wk.harness || "worker", 12), th.text),
            textNode(truncStr(wk.id, 8), th.textMuted),
            textNode("pid:" + (wk.pid || "?"), th.textMuted),
          ], { gap: 1, paddingLeft: 2 }));
        }
      }
      const unattached = sess.filter((s) => s.role === "worker" && !s.coordinatorId);
      for (const wk of unattached) {
        rows.push(hbox([
          textNode("\u25CB", th.warning),
          textNode(truncStr(wk.harness || "worker", 12), th.text),
          textNode(truncStr(wk.id, 8), th.textMuted),
          textNode("unattached", th.warning),
        ], { gap: 1, paddingLeft: 1 }));
      }
    } else if (view() === "timeline") {
      if (evts.length === 0) rows.push(textNode("No events recorded", th.textMuted));

      let lastTs = null;
      for (let i = 0; i < evts.length; i++) {
        const e = evts[i];
        const ts = e.ts ? new Date(e.ts) : null;

        if (lastTs && ts && (lastTs.getTime() - ts.getTime()) > 30000) {
          const gapS = Math.round((lastTs.getTime() - ts.getTime()) / 1000);
          rows.push(textNode("  \u2500 " + formatGap(gapS) + " gap \u2500", RGBA.fromInts(50, 50, 50, 255)));
        }
        lastTs = ts;

        const timeStr = ts ? ts.toTimeString().slice(0, 8) : "?";
        const isInjected = e.result === "injected";
        const isDedup = e.result === "dedup";
        const isClaimed = e.result === "claimed";
        const isHb = e.result === "heartbeat";
        const resultFg = isInjected ? th.success : isDedup ? th.warning : isHb ? th.textMuted : th.text;
        const resultLabel = isInjected ? "injected" : isDedup ? "dedup" : isClaimed ? "claimed" : isHb ? "hb" : "ok";
        const tok = e.tokens || 0;
        const tokEst = estimateTokens(tok);
        const tokFg = tokEst > 20000 ? th.error : tokEst > 5000 ? th.warning : th.primary;
        const isExpanded = isInjected && ek && eventKey(e) === ek;

        const lineChildren = [
          textNode(timeStr, th.textMuted),
          dot(resultFg),
          textNode(truncStr(e.trigger || "?", 10), th.text),
        ];
        if (e.tool) lineChildren.push(textNode(truncStr(e.tool, 8), th.text));
        if (e.file) lineChildren.push(textNode(truncStr(basename(e.file), 20), th.text));
        if (tok > 0) lineChildren.push(boldNode("+" + formatTokenCount(tokEst) + " tok", tokFg));
        else lineChildren.push(textNode(resultLabel, resultFg));
        if (isInjected) lineChildren.push(textNode(isExpanded ? "\u25BC" : "\u25B6", th.textMuted));
        if (e.session) lineChildren.push(textNode(truncStr(e.session, 8), RGBA.fromInts(80, 80, 120, 255)));

        rows.push(hbox(lineChildren, { gap: 1, paddingLeft: 1 }));

        if (isExpanded) {
          const payloadFile = e.payload;
          if (payloadFile) {
            try {
              const content = readFileSync(join(INJECT_LOG_DIR, payloadFile), "utf-8");
              const maxLines = Math.max(10, Math.min(30, Math.floor(h() * 0.4)));
              const lines = content.split("\n");
              const showLines = lines.slice(0, maxLines);
              rows.push(hbox([
                textNode("\u250C\u2500 ", th.primary),
                boldNode(truncStr(e.trigger || "", 12) + " \u00B7 " + formatTokenCount(tokEst) + " tok \u00B7 " + lines.length + " lines", th.primary),
                textNode(" \u2500" + "\u2500".repeat(Math.max(1, pw - 40)), th.primary),
              ], { paddingLeft: 2 }));
              for (const line of showLines) {
                rows.push(hbox([
                  textNode("\u2502 ", th.textMuted),
                  textNode(line.length > pw - 6 ? line.slice(0, pw - 9) + "\u2026" : line, th.text),
                ], { paddingLeft: 2 }));
              }
              if (lines.length > maxLines) {
                rows.push(hbox([
                  textNode("\u2514\u2500 ", th.textMuted),
                  textNode("..." + (lines.length - maxLines) + " more lines (" + content.length + " bytes)", th.textMuted),
                ], { paddingLeft: 2 }));
              } else {
                rows.push(hbox([textNode("\u2514" + "\u2500".repeat(pw - 6), th.textMuted)], { paddingLeft: 2 }));
              }
            } catch {
              rows.push(hbox([textNode("\u2502 (payload file not found)", th.textMuted)], { paddingLeft: 3 }));
            }
          } else {
            rows.push(hbox([textNode("\u2502 (no payload captured)", th.textMuted)], { paddingLeft: 3 }));
          }
        }
      }
    } else if (view() === "locks") {
      const byFile = new Map();
      for (const s of sess) {
        for (const cl of (s.claimedFiles || [])) {
          const owners = byFile.get(cl.path) || [];
          owners.push(s);
          byFile.set(cl.path, owners);
        }
      }
      if (byFile.size === 0) rows.push(textNode("No files claimed", th.textMuted));
      for (const [path, owners] of byFile) {
        const hasConflict = owners.length > 1;
        const fg = hasConflict ? th.error : th.text;
        rows.push(hbox([
          textNode(hasConflict ? "\u26A0" : "\u25CF", fg),
          textNode(truncStr(path, pw - 8), fg),
        ], { gap: 1, paddingLeft: 1 }));
        for (const o of owners) {
          rows.push(hbox([
            textNode("\u2514\u2500", th.textMuted),
            textNode(truncStr(o.harness || "?", 10), th.text),
            textNode(truncStr(o.id, 8), th.textMuted),
            textNode(o.role || "agent", th.textMuted),
          ], { gap: 1, paddingLeft: 3 }));
        }
      }
    }

    // ══ WINDOWED DISPLAY ══
    const totalRows = rows.length;
    const cur = Math.min(cursor(), Math.max(0, totalRows - 1));
    if (cur !== cursor()) setCursor(cur);
    const vr = Math.max(1, visibleRows() - headerLineCount);
    let so = scrollOffset();
    if (cur < so) so = cur;
    else if (cur >= so + vr) so = cur - vr + 1;
    if (so !== scrollOffset()) setScrollOffset(so);
    const sliced = rows.slice(so, so + vr);

    const cursorBarBg = RGBA.fromInts(60, 60, 120, 80);

    const body = [];
    for (let i = 0; i < vr; i++) {
      const rowIdx = so + i;
      const isCursorRow = rowIdx === cur && rowIdx < totalRows;
      const rowEl = sliced[i] || textNode("", th.textMuted);
      if (isCursorRow) {
        const highlight = el("box");
        spread(highlight, { backgroundColor: cursorBarBg, paddingLeft: 1, width: pw });
        insert(highlight, rowEl);
        body.push(highlight);
      } else {
        body.push(rowEl);
      }
    }

    // ══ FOOTER ══
    const footer = [];
    if (conflicts.length > 0) {
      footer.push(hbox([
        textNode("\u26A0 " + conflicts.length + " conflict" + (conflicts.length > 1 ? "s" : ""), th.error),
      ], { paddingTop: 1 }));
    }
    footer.push(textNode("\u2500".repeat(pw), RGBA.fromInts(60, 60, 60, 255)));
    footer.push(hbox([
      textNode("[esc] close", th.textMuted),
      textNode("[\u2191\u2193] navigate", th.textMuted),
      textNode("[\u2190\u2192] views", th.textMuted),
      view() === "timeline" ? textNode("[enter] expand", th.textMuted) : textNode("", th.textMuted),
    ], { gap: 2 }));

    return vbox([...header, ...body, ...footer], {});
  });

  return root;
}

function renderPmdPanel(api, sessionId) {
  const theme = () => api.theme.current;

  const [tick, setTick] = createSignal(Date.now());
  const timer = setInterval(() => setTick(Date.now()), POLL_MS);
  onCleanup(() => clearInterval(timer));

  const [logOpen, setLogOpen] = createSignal(true);
  const [expandedIdx, setExpandedIdx] = createSignal(-1);

  const stats = createMemo(() => { tick(); return tryReadJson(STATS_PATH); });
  const sessions = createMemo(() => { tick(); return readSessions(); });
  const daemonPid = createMemo(() => { tick(); return tryReadPid(); });
  const conflicts = createMemo(() => findConflicts(sessions()));
  const deliveryMode = createMemo(() => stats()?.deliveryMode || "passive");
  const allEvents = createMemo(() => {
    const raw = stats()?.events || [];
    return raw.slice().reverse().slice(0, SIDEBAR_EVENT_CAP);
  });
  const totalEventCount = createMemo(() => (stats()?.events || []).length);

  const dashboard = createMemo(() => { tick(); return tryReadJson(DASHBOARD_PATH); });
  const passiveAgents = createMemo(() => {
    const db = dashboard();
    if (db && db.crew && Array.isArray(db.crew.passiveAgents)
        && typeof db.ts === "number" && Date.now() - db.ts < 30000) {
      return db.crew.passiveAgents.slice(0, 8);
    }
    const raw = stats()?.passiveAgents || [];
    return raw.slice(0, 8);
  });

  const lastError = createMemo(() => { tick(); return readLastError(); });

  const root = el("box");
  spread(root, { flexDirection: "column", gap: 0 });

  insert(root, () => {
    tick();
    logOpen();

    const daemonOk = daemonPid() !== null;
    const sess = sessions();
    const conflictList = findConflicts(sess);
    const evts = allEvents();
    const totalEvts = totalEventCount();
    const dMode = deliveryMode();
    const pAgents = passiveAgents();
    const st = stats();
    const err = lastError();
    const sessionCount = sess.length;
    const passiveCount = pAgents.length;
    const conflictCount = conflictList.length;
    const hooksFired = st?.hooksFired || 0;
    const claimsMade = st?.claimsMade || 0;
    const injectionsDelivered = st?.injectionsDelivered || 0;
    const dedupHits = st?.dedupHits || 0;
    const eventCount = evts.length;
    const ci = findContextSize();
    const contextTokens = ci ? estimateTokens(ci.bytes) : 0;
    const isOpen = logOpen();

    const children = [];

    const headerChildren = [];
    headerChildren.push(boldNode("PipeMD", theme().primary));
    headerChildren.push(dot(daemonOk ? theme().success : theme().error));
    headerChildren.push(textNode(daemonOk ? "running" : "stopped", theme().textMuted));
    if (dMode !== "passive") {
      headerChildren.push(textNode(dMode, theme().textMuted));
    }
    children.push(hbox(headerChildren, { gap: 1 }));

    if (daemonOk) {
      children.push(textNode("pid " + daemonPid(), theme().textMuted));
    }

    if (ci) {
      const tokenFg = contextTokens > 50000 ? theme().error : contextTokens > 20000 ? theme().warning : theme().success;
      children.push(hbox([
        textNode("context", theme().textMuted),
        boldNode(formatTokenCount(contextTokens) + " tok", tokenFg),
        textNode(formatBytes(ci.bytes), theme().textMuted),
      ], { gap: 1 }));
    }

    if (err) {
      const errLines = (err.error || "").split("\n").slice(0, 2);
      children.push(hbox([
        textNode("\u26A0 plugin error", theme().error),
      ], { gap: 1, paddingTop: 1 }));
      for (const line of errLines) {
        children.push(hbox([
          textNode("  " + truncStr(line, 36), theme().textMuted),
        ]));
      }
    }

    if (conflictCount > 0) {
      children.push(hbox([
        textNode("\u26A0 " + conflictCount + " conflict" + (conflictCount > 1 ? "s" : ""), theme().error),
      ]));
    }

    const totalAgents = sessionCount + passiveCount;
    if (totalAgents > 0) {
      const agentsHeaderChildren = [];
      agentsHeaderChildren.push(boldNode("Agents", theme().text));
      agentsHeaderChildren.push(dot(theme().success));
      agentsHeaderChildren.push(textNode(sessionCount + " active", theme().success));
      agentsHeaderChildren.push(dot(theme().warning));
      agentsHeaderChildren.push(textNode(passiveCount + " passive", theme().warning));
      children.push(hbox(agentsHeaderChildren, { gap: 1, paddingTop: 1 }));

      const coordSessions = sess.filter((s) => s.role !== "worker");
      const workerByCoord = new Map();
      for (const w of sess) {
        if (w.role === "worker" && w.coordinatorId) {
          const list = workerByCoord.get(w.coordinatorId) || [];
          list.push(w);
          workerByCoord.set(w.coordinatorId, list);
        }
      }
      const attachedWorkerIds = new Set();
      const totalCrew = sess.length;
      let shown = 0;
      for (const c of coordSessions) {
        if (shown >= MAX_SESSIONS) break;
        shown++;
        const claimed = (c.claimedFiles || []).map((cl) => cl.path).join(", ");
        const lineChildren = [
          dot(theme().success),
          textNode(truncStr(c.harness, 14), theme().text),
          textNode("coord", theme().textMuted),
        ];
        children.push(hbox(lineChildren, { gap: 1, paddingLeft: 1 }));
        if (claimed) {
          children.push(textNode("  claimed: " + truncStr(claimed, 36), theme().textMuted));
        }
        const workers = workerByCoord.get(c.id) || [];
        const visibleWorkers = workers.slice(0, MAX_SESSIONS - shown);
        for (let wi = 0; wi < visibleWorkers.length; wi++) {
          shown++;
          attachedWorkerIds.add(visibleWorkers[wi].id);
          const w = visibleWorkers[wi];
          const hasMore = workers.length > visibleWorkers.length;
          const isLast = wi === visibleWorkers.length - 1;
          const prefix = isLast && !hasMore ? "\u2514\u2500" : "\u251C\u2500";
          const wClaimed = (w.claimedFiles || []).map((cl) => cl.path).join(", ");
          const wLabel = w.label ? truncStr(w.label, 16) : truncStr(w.id, 10);
          const wLineChildren = [
            textNode(prefix, theme().textMuted),
            dot(theme().primary),
            textNode(truncStr(w.harness || "worker", 12), theme().text),
            textNode(wLabel, theme().textMuted),
          ];
          children.push(hbox(wLineChildren, { gap: 1, paddingLeft: 2 }));
          if (wClaimed) {
            children.push(textNode("    claimed: " + truncStr(wClaimed, 34), theme().textMuted));
          }
        }
        const hiddenWorkers = workers.length - visibleWorkers.length;
        if (hiddenWorkers > 0) {
          shown += hiddenWorkers;
          children.push(hbox([
            textNode("\u2514\u2500", theme().textMuted),
            textNode("+" + hiddenWorkers + " more worker" + (hiddenWorkers > 1 ? "s" : ""), theme().textMuted),
          ], { gap: 1, paddingLeft: 2 }));
        }
      }
      const unattached = sess.filter((s) => s.role === "worker" && !attachedWorkerIds.has(s.id));
      for (const w of unattached.slice(0, Math.max(0, MAX_SESSIONS - shown))) {
        shown++;
        const wClaimed = (w.claimedFiles || []).map((cl) => cl.path).join(", ");
        const wLineChildren = [
          dot(theme().warning),
          textNode(truncStr(w.harness || "worker", 12), theme().text),
          textNode("worker", theme().textMuted),
        ];
        children.push(hbox(wLineChildren, { gap: 1, paddingLeft: 1 }));
        if (wClaimed) {
          children.push(textNode("  claimed: " + truncStr(wClaimed, 36), theme().textMuted));
        }
      }
      const hidden = totalCrew - shown;
      if (hidden > 0) {
        children.push(hbox([
          textNode("\u2022 +" + hidden + " more session" + (hidden > 1 ? "s" : ""), theme().textMuted),
        ], { gap: 1, paddingLeft: 1 }));
      }

      for (const pa of pAgents) {
        const lineChildren = [
          dot(theme().warning),
          textNode(truncStr(pa, 32), theme().text),
        ];
        children.push(hbox(lineChildren, { gap: 1, paddingLeft: 1 }));
      }
    }

    // ── Hook log (retractable, capped) ──
    if (evts.length > 0 || totalEvts > 0) {
      const logHeaderChildren = [];
      const arrow = el("text");
      spread(arrow, { fg: theme().text });
      insert(arrow, txt(isOpen ? "\u25BC" : "\u25B6"));
      logHeaderChildren.push(arrow);
      logHeaderChildren.push(boldNode("Hook Log", theme().text));
      logHeaderChildren.push(textNode(eventCount + "/" + totalEvts, theme().textMuted));
      if (!isOpen && hooksFired > totalEvts) {
        logHeaderChildren.push(textNode("(" + hooksFired + " total)", theme().textMuted));
      }
      children.push(hbox(logHeaderChildren, { gap: 1, paddingTop: 1, onMouseDown: () => setLogOpen((x) => !x) }));

      if (isOpen && evts.length > 0) {
        const totalInjected = evts.reduce((s, e) => s + (e.tokens || 0), 0);
        if (totalInjected > 0) {
          children.push(hbox([
            boldNode(formatTokenCount(estimateTokens(totalInjected)) + " tok", theme().primary),
            textNode("injected", theme().textMuted),
            textNode("\u2139 click row", theme().textMuted),
          ], { gap: 1, paddingLeft: 1 }));
        }

        const expIdx = expandedIdx();
        const sidebarWidth = 44;

        for (let i = 0; i < evts.length; i++) {
          const e = evts[i];
          const ago = formatTimeAgo(e.ts);
          const isInjected = e.result === "injected";
          const isDedup = e.result === "dedup";
          const isClaimed = e.result === "claimed";
          const isHeartbeat = e.result === "heartbeat";
          const resultDotFg = isInjected ? theme().primary : isDedup ? theme().textMuted : isClaimed ? theme().warning : isHeartbeat ? theme().textMuted : theme().success;
          const triggerStr = truncStr(e.trigger, 8);
          const toolStr = e.tool ? truncStr(e.tool, 6) : "";
          const fileStr = e.file ? truncStr(basename(e.file), 14) : "";
          const tok = e.tokens || 0;
          const tokStr = tok > 0 ? "+" + formatTokenCount(estimateTokens(tok)) + " tok" : "";
          const resultLabel = isInjected ? "injected" : isDedup ? "dedup" : isClaimed ? "claimed" : isHeartbeat ? "hb" : "ok";

          const lineChildren = [
            dot(resultDotFg),
            textNode(ago, theme().textMuted),
            textNode(triggerStr, theme().text),
          ];
          if (toolStr) lineChildren.push(textNode(toolStr, theme().text));
          if (fileStr) lineChildren.push(textNode(fileStr, theme().text));
          if (tokStr) lineChildren.push(boldNode(tokStr, theme().primary));
          else lineChildren.push(textNode(resultLabel, resultDotFg));
          if (isInjected) {
            lineChildren.push(textNode(expIdx === i ? "\u25BC" : "\u25B6", theme().textMuted));
          }
          children.push(hbox(lineChildren, {
            gap: 1,
            paddingLeft: 1,
            onMouseDown: isInjected ? (() => { const idx = i; return () => setExpandedIdx((prev) => prev === idx ? -1 : idx); })() : undefined,
          }));

          if (isInjected && expIdx === i) {
            const payloadFile = e.payload;
            if (payloadFile) {
              try {
                const content = readFileSync(join(INJECT_LOG_DIR, payloadFile), "utf-8");
                const lines = content.split("\n").slice(0, 12);
                for (const line of lines) {
                  children.push(hbox([
                    textNode("\u2502 ", theme().textMuted),
                    textNode(line.length > sidebarWidth ? line.slice(0, sidebarWidth - 3) + "\u2026" : line, theme().textMuted),
                  ], { paddingLeft: 3 }));
                }
                if (content.split("\n").length > 12) {
                  children.push(hbox([textNode("\u2502 ... (" + content.length + " bytes)", theme().textMuted)], { paddingLeft: 3 }));
                }
                children.push(hbox([textNode("\u2502 [Alt+P] full view", theme().textMuted)], { paddingLeft: 3 }));
              } catch {
                children.push(hbox([textNode("\u2502 (payload file not found)", theme().textMuted)], { paddingLeft: 3 }));
              }
            } else {
              children.push(hbox([textNode("\u2502 (no payload captured)", theme().textMuted)], { paddingLeft: 3 }));
            }
          }
        }

        if (totalEvts > SIDEBAR_EVENT_CAP) {
          children.push(hbox([
            textNode("[Alt+P] view all " + totalEvts + " events", theme().textMuted),
          ], { paddingTop: 1 }));
        }
      }
    }

    // ── Stats footer ──
    const footerLine1 = [
      textNode(hooksFired + " hooks", theme().textMuted),
      dot(theme().textMuted),
      textNode(claimsMade + " claims", theme().textMuted),
      dot(theme().textMuted),
      textNode(totalEvts + " events", theme().textMuted),
    ];
    children.push(hbox(footerLine1, { gap: 1, paddingTop: 1 }));
    if (dMode !== "passive") {
      children.push(hbox([
        textNode(injectionsDelivered + " sent", theme().textMuted),
        dot(theme().textMuted),
        textNode(dedupHits + " deduped", theme().textMuted),
      ], { gap: 1 }));
    }

    return vbox(children, {});
  });

  return root;
}

export default {
  id: "pmd-crew-tui",
  tui: async (api) => {
    api.slots.register({
      order: 250,
      slots: {
        sidebar_content(_ctx, props) {
          if (!existsSync(".pipemd/config.yml")) return null;
          return renderPmdPanel(api, props.session_id);
        },
      },
    });

    api.command.register(() => [{
      title: "PipeMD: Resolution Trace",
      value: "pmd-trace",
      keybind: "alt+p",
      category: "PipeMD",
      onSelect: () => {
        if (api.route.current.name === "pmd-trace") {
          const prev = savedRoute;
          savedRoute = null;
          if (prev && prev.name === "session" && prev.params && prev.params.sessionID) {
            api.route.navigate("session", { sessionID: prev.params.sessionID });
          } else {
            api.route.navigate("home");
          }
        } else {
          savedRoute = api.route.current;
          api.route.navigate("pmd-trace");
        }
      },
    }]);

    api.route.register([{
      name: "pmd-trace",
      render: () => renderTraceRoute(api),
    }]);
  },
};
