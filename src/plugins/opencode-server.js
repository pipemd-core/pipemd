// pmd-crew — PipeMD Crew coordination plugin.
// Installed by `pmd init`. Safe to delete manually.
// @pmd-plugin-version ${PLUGIN_VERSION}
//
// Events:
//   tool.execute.before → heartbeat + injection (active mode)
//   tool.execute.after  → claim edits + async validation
//   event(session.idle / session.status) → heartbeat + worker cleanup
//   experimental.chat.system.transform → sub-agent detection + LLM context injection
import { execFile, execFileSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync, renameSync, appendFileSync, statSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { resolve as resolvePath, join as joinPath, dirname as pathDirname } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";

const PLUGIN_DIR = joinPath(process.cwd(), ".opencode", "plugin");
const CONFIG_PATH = joinPath(PLUGIN_DIR, "pmd-config.json");

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    if (existsSync(CONFIG_PATH)) {
      appendFileSync(ERROR_LOG_PATH, JSON.stringify({ ts: Date.now(), handler: "loadConfig", error: String(e?.message || e) }) + "\n", "utf-8");
    }
    return { delivery: "passive" };
  }
}

const CONFIG = loadConfig();
const WITH_INJECTION = CONFIG.delivery === "active" || CONFIG.delivery === "expert";

const FIFO_TEMP_DIR = mkdtempSync(joinPath(tmpdir(), "pmd-fifo-"));
const RENDERED_SNAPSHOT = joinPath(process.cwd(), ".pipemd", "live", ".render.md");

// P3 — Clean up FIFO temp files on exit so they don't accumulate in $TMPDIR.
function cleanupFifoTempDir() {
  try { rmSync(FIFO_TEMP_DIR, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanupFifoTempDir);
process.on("SIGINT", () => { cleanupFifoTempDir(); process.exit(0); });
process.on("SIGTERM", () => { cleanupFifoTempDir(); process.exit(0); });

function isFifoFile(filePath) {
  if (!filePath) return false;
  try { return statSync(resolvePath(filePath)).isFIFO(); } catch { return false; }
}

function redirectArgs(args, target) {
  if ("filePath" in args) args.filePath = target;
  if ("path" in args) args.path = target;
  if ("file_path" in args) args.file_path = target;
}

function resolveFifoRead(args) {
  const filePath = extractFilePath(args);
  if (!isFifoFile(filePath)) return;
  const tempFile = joinPath(FIFO_TEMP_DIR, `${crypto.randomUUID()}.md`);
  try {
    const data = readFileSync(RENDERED_SNAPSHOT, "utf-8");
    if (data) { writeFileSync(tempFile, data, "utf-8"); redirectArgs(args, tempFile); return; }
  } catch {}
  try {
    execFileSync(getPmdBin(), ["run", "-o", tempFile], { encoding: "utf-8", timeout: 10000, stdio: "ignore" });
    if (existsSync(tempFile)) { redirectArgs(args, tempFile); return; }
  } catch (e) { logPluginError("resolveFifoRead", e); }
  try { writeFileSync(tempFile, "> ⚠️ PipeMD context unavailable. Run `pmd status`.\n", "utf-8"); } catch {}
  redirectArgs(args, tempFile);
}

function resolvePmd() {
  const local = resolvePath(process.cwd(), "node_modules/.bin/pmd");
  if (existsSync(local)) return local;
  try {
    const which = execFileSync("which", ["pmd"], { encoding: "utf-8", timeout: 3000 }).trim();
    if (which) return which;
  } catch {}
  return "pmd";
}

let _cachedBin = "";
function getPmdBin() {
  if (process.env.PMD_BIN) return process.env.PMD_BIN;
  if (!_cachedBin) { _cachedBin = resolvePmd(); return _cachedBin; }
  if (!existsSync(_cachedBin)) { _cachedBin = resolvePmd(); }
  return _cachedBin;
}
const STATS_PATH = joinPath(".pipemd", ".tui-stats.json");
const ERROR_LOG_PATH = joinPath(".pipemd", ".plugin-errors.log");
const INJECT_LOG_DIR = joinPath(".pipemd", ".injection-log");
const MAX_ERROR_LINES = 20;

const stats = {
  hooksFired: 0,
  claimsMade: 0,
  injectionsDelivered: 0,
  dedupHits: 0,
  deliveryMode: CONFIG.delivery || "passive",
  events: [],
  passiveAgents: [],
};

let lastInjection = null;
let stableInjected = false;
let injectLogCounter = 0;
let coordinatorCrewId = "";
let coordinatorOcSessionId = "";
let activeOcSessionId = "";
const workerSessions = new Map();
let lastAgentRefresh = 0;
let planModeDetected = false;
let planModeLastCheck = 0;
let serverUrl = "";
let serverAuthHeader = "";

function formatTok(n) {
  if (n < 1000) return n + " tok";
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k tok";
}

function storePayload(trigger, payload) {
  try {
    mkdirSync(INJECT_LOG_DIR, { recursive: true });
    injectLogCounter++;
    const sid = getActiveCrewSession();
    const meta = "[pmd-meta session=" + (sid || "") + " trigger=" + (trigger || "") + "]\n";
    const filename = injectLogCounter + ".txt";
    writeFileSync(joinPath(INJECT_LOG_DIR, filename), meta + payload, "utf-8");
    writeFileSync(joinPath(INJECT_LOG_DIR, "last.txt"), meta + payload, "utf-8");
    stats.lastPayloadFile = filename;
  } catch (e) { logPluginError("storePayload", e); }
}

const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro"]);

function extractFilePath(args) {
  return args.path || args.filePath || args.file_path || "";
}

const LAST_READ_TTL = 300_000;

function recordLastRead(sessionId, filePath) {
  try {
    const dir = joinPath(".pipemd", "cache", "sources");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const safeKey = ("last-read:" + (sessionId || "") + ":" + filePath).replace(/[/\\]/g, "%2F") + ".json";
    const hash = crypto.createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 8);
    const entry = JSON.stringify({ key: "last-read", data: "", hash, timestamp: Date.now(), ttl: LAST_READ_TTL });
    writeFileSync(joinPath(dir, safeKey), entry, "utf-8");
  } catch {}
}

function isEditTool(tool) {
  return /^(write|edit|patch)$/i.test(tool || "");
}

function logPluginError(handler, err) {
  try {
    mkdirSync(".pipemd", { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), handler, error: String(err?.message || err) }) + "\n";
    appendFileSync(ERROR_LOG_PATH, line, "utf-8");
    const raw = readFileSync(ERROR_LOG_PATH, "utf-8").split("\n").filter(Boolean);
    if (raw.length > MAX_ERROR_LINES) {
      writeFileSync(ERROR_LOG_PATH, raw.slice(-MAX_ERROR_LINES).join("\n") + "\n", "utf-8");
    }
  } catch {}
}

function refreshAgents() {
  const now = Date.now();
  if (now - lastAgentRefresh < 30000) return;
  lastAgentRefresh = now;
  execFile(getPmdBin(), ["crew", "status", "--json"], { encoding: "utf-8", timeout: 5000 }, (err, stdout) => {
    if (err) return;
    try {
      const data = JSON.parse(stdout);
      stats.passiveAgents = Array.isArray(data.passiveAgents) ? data.passiveAgents : [];
    } catch {}
  });
}

function writeStats() {
  try {
    mkdirSync(".pipemd", { recursive: true });
    const tmp = STATS_PATH + `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify(stats) + "\n", "utf-8");
    renameSync(tmp, STATS_PATH);
  } catch {}
}

function pushEvent(trigger, tool, file, result, tokens) {
  stats.hooksFired++;
  const sid = getActiveCrewSession();
  const entry = { trigger, tool: tool || "", file: file || "", result, tokens: tokens || 0, ts: new Date().toISOString(), session: sid || undefined };
  if (result === "injected" && stats.lastPayloadFile) {
    entry.payload = stats.lastPayloadFile;
    stats.lastPayloadFile = "";
  }
  stats.events.push(entry);
  if (stats.events.length > 100) stats.events = stats.events.slice(-100);
  writeStats();
}

function pmd(args) {
  execFile(getPmdBin(), args, (err) => {
    if (process.env.PMD_CREW_DEBUG) console.error("[pmd-crew]", err && err.message);
  });
}

function pmdSync(args) {
  try {
    return execFileSync(getPmdBin(), args, { encoding: "utf-8", timeout: 3000 }).trim();
  } catch (e) {
    logPluginError("pmdSync", e);
    return "";
  }
}

function parseCrewId(out) {
  const m = (out || "").match(/cr_[0-9a-f]+/);
  return m ? m[0] : "";
}

function coordinatorAlive() {
  if (!coordinatorCrewId) return false;
  try {
    return existsSync(joinPath(".pipemd", "crew", coordinatorCrewId + ".json"));
  } catch { return false; }
}

function join() {
  if (coordinatorAlive()) return;
  coordinatorCrewId = "";
  const out = pmdSync(["crew", "join"]);
  coordinatorCrewId = parseCrewId(out);
  if (!coordinatorOcSessionId) coordinatorOcSessionId = activeOcSessionId;
  refreshAgents();
}

function claim(filePath) {
  if (typeof filePath !== "string" || !filePath) return;
  stats.claimsMade++;
  const sid = getActiveCrewSession();
  if (sid) pmd(["crew", "claim", filePath, "--session", sid]);
  else pmd(["crew", "claim", filePath]);
}

function heartbeat() {
  if (!coordinatorAlive()) {
    coordinatorCrewId = "";
    cleanupOrphanedWorkers();
    join();
  }
  const sid = getActiveCrewSession();
  if (sid) pmd(["crew", "heartbeat", "--session", sid]);
  else pmd(["crew", "heartbeat"]);
  refreshAgents();
}

const PLAN_CHECK_INTERVAL = 30_000;

async function detectPlanMode(ocSessionId) {
  if (!serverUrl || !ocSessionId) return false;
  const now = Date.now();
  if (now - planModeLastCheck < PLAN_CHECK_INTERVAL) return planModeDetected;
  planModeLastCheck = now;
  try {
    const headers = { "Content-Type": "application/json" };
    if (serverAuthHeader) headers["Authorization"] = serverAuthHeader;
    const resp = await fetch(serverUrl + "/session/" + ocSessionId, { headers, signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return planModeDetected;
    const data = await resp.json();
    const isPlan = data.agent === "plan";
    if (isPlan !== planModeDetected) {
      planModeDetected = isPlan;
      const sid = getActiveCrewSession();
      if (isPlan) {
        const planPath = constructPlanPath(data);
        const noteText = planPath ? `Planning: ${planPath}` : "In plan mode (read-only)";
        if (sid) pmd(["crew", "note", noteText, "--session", sid]);
        else pmd(["crew", "note", noteText]);
      } else {
        if (sid) pmd(["crew", "note", "", "--session", sid]);
        else pmd(["crew", "note", ""]);
      }
    }
    return isPlan;
  } catch {
    return planModeDetected;
  }
}

function constructPlanPath(sessionData) {
  try {
    const slug = sessionData.slug || "";
    const created = sessionData.time && sessionData.time.created;
    if (!slug || !created) return "";
    return joinPath(".opencode", "plans", [created, slug].join("-") + ".md");
  } catch { return ""; }
}

function captureTodos(toolName, output) {
  if (toolName !== "todowrite") return;
  try {
    const todos = output && output.metadata && output.metadata.todos;
    if (!Array.isArray(todos)) return;
    const active = todos.filter(t => t.status === "in_progress" || t.status === "pending");
    updateCrewNoteForTodos(active);
  } catch {}
}

function updateCrewNoteForTodos(activeTodos) {
  const sid = getActiveCrewSession();
  if (!sid) return;
  if (planModeDetected) return;
  if (activeTodos.length === 0) {
    pmd(["crew", "note", "", "--session", sid]);
    return;
  }
  const first = activeTodos[0];
  const noteText = `Working: ${first.content}` + (activeTodos.length > 1 ? ` (+${activeTodos.length - 1} more)` : "");
  pmd(["crew", "note", noteText, "--session", sid]);
}

function getActiveCrewSession() {
  if (activeOcSessionId && workerSessions.has(activeOcSessionId)) {
    return workerSessions.get(activeOcSessionId);
  }
  return coordinatorCrewId || "";
}

function handleSessionSwitch(ocSid) {
  if (!ocSid) return;
  if (!activeOcSessionId) {
    activeOcSessionId = ocSid;
    coordinatorOcSessionId = ocSid;
    return;
  }
  if (ocSid === activeOcSessionId) return;
  if (ocSid === coordinatorOcSessionId) {
    activeOcSessionId = ocSid;
    return;
  }
  if (!coordinatorAlive()) {
    join();
    if (!coordinatorCrewId) return;
  }
  if (!workerSessions.has(ocSid)) {
    const parentCrewId = coordinatorCrewId;
    if (!parentCrewId) return;
    const out = pmdSync(["crew", "join", "--role", "worker", "--coordinator", parentCrewId]);
    const wid = parseCrewId(out);
    if (wid) {
      workerSessions.set(ocSid, wid);
      pushEvent("subagent-join", "", "", "worker-joined", 0);
    }
  }
  activeOcSessionId = ocSid;
}

function leaveWorker(ocSid) {
  const wid = workerSessions.get(ocSid);
  if (wid) {
    workerSessions.delete(ocSid);
    pmd(["crew", "leave", "--session", wid]);
    pushEvent("subagent-leave", "", "", "worker-left", 0);
  }
  if (activeOcSessionId === ocSid) {
    activeOcSessionId = coordinatorOcSessionId;
  }
}

function cleanupOrphanedWorkers() {
  for (const [ocSid, wid] of workerSessions) {
    try {
      if (!existsSync(joinPath(".pipemd", "crew", wid + ".json"))) {
        workerSessions.delete(ocSid);
      }
    } catch { /* ignore */ }
  }
}

async function beforeHandler(input, output) {
  try {
    const tool = (input && input.tool) || "";
    const args = (output && output.args) || {};
    if (tool === "read") resolveFifoRead(args);
    const trigger = isEditTool(tool) ? "before-edit" : "before-read";
    const filePath = extractFilePath(args);
    join(); heartbeat();

    if (tool === "read" && filePath) {
      recordLastRead(getActiveCrewSession(), filePath);
    }

    if (WITH_INJECTION) {
      const sid = getActiveCrewSession();
      try {
        const out = execFileSync(getPmdBin(), ["inject", "--trigger", trigger, "--file", filePath, "--session", sid], { encoding: "utf-8", timeout: 5000 });
        if (out.trim()) {
          lastInjection = { payload: out.trim(), bytes: out.length, trigger, tool, file: filePath, ts: Date.now() };
          stats.injectionsDelivered++;
          storePayload(trigger, out.trim());
          pushEvent(trigger, tool, filePath, "injected", out.length);
        } else {
          lastInjection = null;
          stats.dedupHits++;
          pushEvent(trigger, tool, filePath, "dedup", 0);
        }
      } catch (e) { lastInjection = null; logPluginError("tool.execute.before", e); pushEvent(trigger, tool, filePath, "ok", 0); }
    } else {
      pushEvent("before", tool, extractFilePath(args), "ok", 0);
    }
  } catch (e) { logPluginError("tool.execute.before", e); }
}

async function buildEditFeedback(filePath) {
  if (!filePath) return null;
  const ext = (filePath.lastIndexOf(".") >= 0 ? filePath.slice(filePath.lastIndexOf(".")) : "").toLowerCase();
  if (!CODE_EXTENSIONS.has(ext)) return null;
  const parts = [];

  try {
    const out = execFileSync(getPmdBin(), ["inject", "--trigger", "before-edit", "--file", filePath, "--session", getActiveCrewSession()], { encoding: "utf-8", timeout: 3000 }).trim();
    if (out) {
      const lines = out.split("\n");
      for (const line of lines) {
        if (line.includes("⚠️ CONFLICT")) {
          parts.push("[pmd] " + line.replace(/^\[pmd:[^\]]*\]\s*/, "").trim());
        }
      }
    }
  } catch (e) { /* non-critical */ }

  try {
    const out = execFileSync(getPmdBin(), ["validate", "--file", filePath], { encoding: "utf-8", timeout: 4000 }).trim();
    if (out && out !== "No errors found" && out !== "ok") {
      const errors = out.split("\n").slice(0, 5).join("\n");
      parts.push("[pmd] ⚠ errors in " + filePath + ":\n" + errors);
    }
  } catch (e) { /* non-critical */ }

  if (parts.length === 0) return null;
  return parts.join("\n");
}

async function afterHandler(input, output) {
  try {
    const tool = (input && input.tool) || "";
    captureTodos(tool, output);
    const isEdit = isEditTool(tool);

    if (WITH_INJECTION && lastInjection && typeof (output && output.output) === "string") {
      output.output += "\n\n" + lastInjection.payload;
      storePayload(lastInjection.trigger + "-inline", lastInjection.payload);
      pushEvent(lastInjection.trigger + "-inline", tool, lastInjection.file || "", "injected-inline", lastInjection.bytes);
      lastInjection = null;
    }

    if (isEdit) {
      const args = (output && output.args) || (input && input.args) || {};
      const filePath = extractFilePath(args);
      claim(filePath);

      if (WITH_INJECTION) {
        const sid = getActiveCrewSession();
        try {
          execFileSync(getPmdBin(), ["inject", "--trigger", "after-edit", "--file", extractFilePath(args), "--async-validate", "--session", sid], { encoding: "utf-8", timeout: 3000, stdio: "ignore" });
        } catch (e) { logPluginError("after-edit-async", e); }
        try {
          pmd(["inject", "--invalidate", filePath]);
        } catch (e) { /* non-critical */ }
        pushEvent("after-edit", tool, filePath || "", "claimed", 0);

        const feedback = await buildEditFeedback(filePath);
        if (feedback && typeof (output && output.output) === "string") {
          output.output += "\n" + feedback;
        }
      }
    }

    if (!WITH_INJECTION && isEdit) {
      pushEvent("after-edit", tool, "", "claimed", 0);
    }
  } catch (e) { logPluginError("tool.execute.after", e); }
}

async function systemTransform(input, output) {
  if (!WITH_INJECTION) return;
  try {
    handleSessionSwitch(input && input.sessionID);
    const sid = getActiveCrewSession();
    detectPlanMode(input && input.sessionID);
    if (!stableInjected) {
      try {
        const stable = execFileSync(getPmdBin(), ["inject", "--trigger", "on-start", "--session", sid], { encoding: "utf-8", timeout: 5000 });
        const stableTrimmed = (stable || "").trim();
        if (stableTrimmed) {
          stats.injectionsDelivered++;
          storePayload("on-start", stableTrimmed);
          pushEvent("on-start", "", "", "injected", stable.length);
          output.system.push(stableTrimmed);
        }
      } catch (e) { logPluginError("on-start", e); }
      stableInjected = true;
    }
    const out = execFileSync(getPmdBin(), ["inject", "--trigger", "on-idle", "--session", sid], { encoding: "utf-8", timeout: 5000 });
    const trimmed = (out || "").trim();
    if (trimmed) {
      stats.injectionsDelivered++;
      storePayload("system-transform", trimmed);
      pushEvent("system-transform", "", "", "injected", out.length);
      output.system.push(trimmed);
    }
  } catch (e) { logPluginError("system.transform", e); }
}

async function eventHandler({ event }) {
  try {
    if (!event) return;
    const eventType = event.type;
    const props = event.properties || {};
    if (eventType === "session.idle") {
      const ocSid = props.sessionID;
      if (ocSid && workerSessions.has(ocSid)) {
        leaveWorker(ocSid);
      } else {
        heartbeat();
      }
      pushEvent("on-idle", "", "", "heartbeat", 0);
    } else if (eventType === "session.status" && props.status && props.status.type === "idle") {
      const ocSid = props.sessionID;
      if (ocSid && workerSessions.has(ocSid)) {
        leaveWorker(ocSid);
      }
    }
  } catch (e) { logPluginError("event", e); }
}

join();
writeStats();
const heartbeatTimer = setInterval(() => { try { heartbeat(); } catch {} }, 30_000);
heartbeatTimer.unref();

export default {
  id: "pmd-crew",
  server: async (input) => {
    if (input && input.serverUrl) {
      serverUrl = input.serverUrl.origin || input.serverUrl.toString();
    }
    return {
    "tool.execute.before": beforeHandler,
    "tool.execute.after": afterHandler,
    "experimental.chat.system.transform": systemTransform,
    "event": eventHandler,
    };
  },
};
