import fs from "node:fs";
import path from "node:path";
import { getStatusJson } from "./crew.js";
import { atomicWrite } from "./fs-utils.js";
import { PIPEMD_DIR, STATUS_FILE, PID_FILE, INJECT_STATS_FILE, TUI_STATS_FILE, CONTEXT_FILES } from "./paths.js";
import { tryReadJson, isPidAlive, readInjectStats } from "./json-utils.js";

export const DASHBOARD_FILE = path.join(PIPEMD_DIR, ".dashboard.json");

const PLUGIN_ERROR_STALE_MS = 300_000;

export interface DashboardData {
  ts: number;
  daemon: {
    pid: number | null;
    uptime: number;
  };
  crew: {
    sessions: Array<{
      id: string;
      role: string;
      harness: string;
      label?: string;
      claimedFiles: string[];
      note?: string;
      lastHeartbeat: string;
    }>;
    conflicts: Array<{ path: string; sessionIds: string[] }>;
    harnessCount: number;
    sessionCount: number;
    passiveAgents: string[];
    uncommittedFiles: string[];
  };
  context: {
    bytes: number;
    tokens: number;
  };
  injection: {
    delivered: number;
    dedup: number;
    lastEvent?: {
      trigger: string;
      file: string;
      result: string;
      ts: number;
    };
  };
  events: Array<{
    trigger: string;
    tool: string;
    file: string;
    result: string;
    tokens: number;
    ts: string;
    payload?: string;
  }>;
  hooksFired: number;
  deliveryMode: string;
  pluginError?: {
    ts: number;
    handler: string;
    error: string;
  };
}

const ERROR_LOG_PATH = path.join(PIPEMD_DIR, ".plugin-errors.log");

function readDaemonPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (pid > 0 && isPidAlive(pid)) return pid;
  } catch {}
  return null;
}

function readContextBytes(): number {
  const st = tryReadJson(STATUS_FILE);
  if (st && typeof st.renderedBytes === "number" && st.renderedBytes > 0) return st.renderedBytes;
  for (const f of CONTEXT_FILES) {
    try { const s = fs.statSync(f); if (s.isFile() && s.size > 0) return s.size; } catch {}
  }
  return 0;
}

function readLastError(): { ts: number; handler: string; error: string } | undefined {
  try {
    const raw = fs.readFileSync(ERROR_LOG_PATH, "utf-8").split("\n").filter(Boolean);
    if (raw.length === 0) return undefined;
    const last = JSON.parse(raw[raw.length - 1]);
    if (last && typeof last.ts === "number" && Date.now() - last.ts < PLUGIN_ERROR_STALE_MS) return last;
  } catch {}
  return undefined;
}

let daemonStartTime = Date.now();

export function writeDashboard(): void {
  const pid = readDaemonPid();
  const crew = getStatusJson();
  const bytes = readContextBytes();
  const stats = readInjectStats(INJECT_STATS_FILE);
  const tuiStats = tryReadJson(TUI_STATS_FILE);
  const pluginError = readLastError();

  const dashboard: DashboardData = {
    ts: Date.now(),
    daemon: {
      pid,
      uptime: pid ? Date.now() - daemonStartTime : 0,
    },
    crew,
    context: {
      bytes,
      tokens: Math.round(bytes / 4),
    },
    injection: stats,
    events: tuiStats?.events || [],
    hooksFired: tuiStats?.hooksFired || 0,
    deliveryMode: tuiStats?.deliveryMode || "passive",
    pluginError,
  };

  atomicWrite(DASHBOARD_FILE, JSON.stringify(dashboard) + "\n");
}

export function readDashboard(): DashboardData | null {
  return tryReadJson(DASHBOARD_FILE);
}

export function resetDaemonStart(): void {
  daemonStartTime = Date.now();
}
