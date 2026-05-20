// pmd-crew — PipeMD Crew coordination plugin.
// Installed by `pmd crew install-hooks`. Safe to delete manually.
// @pmd-plugin-version ${PLUGIN_VERSION}
//
// Events:
//   tool.execute.before → heartbeat + injection (active mode)
//   tool.execute.after  → claim edits + async validation
//   event(session.idle / session.status) → heartbeat + worker cleanup
//   experimental.chat.system.transform → sub-agent detection + LLM context injection
import { execFile, execFileSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync, renameSync, appendFileSync } from "node:fs";
import { resolve as resolvePath, join as joinPath } from "node:path";

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
const MAX_ERROR_LINES = 20;

const stats = {
  hooksFired: 0,
  claimsMade: 0,
  injectionsDelivered: 0,
  dedupHits: 0,
  deliveryMode: "${DELIVERY_MODE}",
  events: [],
  passiveAgents: [],
};

let coordinatorCrewId = "";
let coordinatorOcSessionId = "";
let activeOcSessionId = "";
const workerSessions = new Map();

let lastAgentRefresh = 0;

${INJECTION_HELPERS}

function extractFilePath(args) {
  return args.path || args.filePath || args.file_path || "";
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
  try {
    const out = execFileSync(getPmdBin(), ["crew", "status", "--json"], { encoding: "utf-8", timeout: 5000 });
    const data = JSON.parse(out);
    stats.passiveAgents = Array.isArray(data.passiveAgents) ? data.passiveAgents : [];
  } catch {}
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
  if (stats.events.length > 10) stats.events = stats.events.slice(-10);
  writeStats();
}

function pmd(args) {
  execFile(getPmdBin(), args, (err) => {
    if (process.env.PMD_CREW_DEBUG) console.error("[pmd-crew]", err && err.message);
  });
}

function pmdSync(args) {
  try {
    return execFileSync(getPmdBin(), args, { encoding: "utf-8", timeout: 10000 }).trim();
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
    const parentCrewId = workerSessions.has(activeOcSessionId)
      ? workerSessions.get(activeOcSessionId)
      : coordinatorCrewId;
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

join();
writeStats();
setInterval(() => { try { heartbeat(); } catch {} }, 30_000);

export default {
  id: "pmd-crew",
  server: async () => ({
    ${BEFORE_HANDLER}
    ${AFTER_HANDLER}
    ${SYSTEM_TRANSFORM}
    ${EVENT_HANDLER}
  }),
};
