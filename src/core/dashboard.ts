import fs from "node:fs";
import path from "node:path";
import { getStatusJson } from "./crew-render.js";
import { atomicWrite } from "./fs-utils.js";
import { PIPEMD_DIR, PID_FILE, TUI_STATS_FILE } from "./paths.js";
import { tryReadJson, isPidAlive } from "./json-utils.js";
import { findContextBytes, readInjectStats } from "./statusline-data.js";
import { log, errMsg } from "./logger.js";

const DASHBOARD_FILE = path.join(PIPEMD_DIR, ".dashboard.json");

const PLUGIN_ERROR_STALE_MS = 300_000;

interface DashboardData {
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
  } catch (err: unknown) { log.debug(`read daemon pid: ${errMsg(err)}`); }
  return null;
}

function readContextBytesFromDashboard(): number {
  return findContextBytes(PIPEMD_DIR, process.cwd());
}

function readLastError(): { ts: number; handler: string; error: string } | undefined {
  try {
    const raw = fs.readFileSync(ERROR_LOG_PATH, "utf-8").split("\n").filter(Boolean);
    if (raw.length === 0) return undefined;
    const last = JSON.parse(raw[raw.length - 1]);
    if (last && typeof last.ts === "number" && Date.now() - last.ts < PLUGIN_ERROR_STALE_MS) return last;
  } catch (err: unknown) { log.debug(`read plugin error log: ${errMsg(err)}`); }
  return undefined;
}

let daemonStartTime = Date.now();

export function writeDashboard(): void {
  const pid = readDaemonPid();
  const crew = getStatusJson();
  const bytes = readContextBytesFromDashboard();
  const stats = readInjectStats(PIPEMD_DIR);
  const tuiStats = tryReadJson<{
    events?: unknown[];
    hooksFired?: number;
    deliveryMode?: string;
  }>(TUI_STATS_FILE);
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
    events: (tuiStats?.events || []) as DashboardData["events"],
    hooksFired: tuiStats?.hooksFired || 0,
    deliveryMode: tuiStats?.deliveryMode || "passive",
    pluginError,
  };

  atomicWrite(DASHBOARD_FILE, JSON.stringify(dashboard) + "\n");
}

function readDashboard(): DashboardData | null {
  return tryReadJson<DashboardData>(DASHBOARD_FILE);
}

export function resetDaemonStart(): void {
  daemonStartTime = Date.now();
}
