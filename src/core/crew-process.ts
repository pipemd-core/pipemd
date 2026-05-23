import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
  cwd?: string;
}

export const HARNESS_PROCESS_PATTERNS: { harness: string; pattern: RegExp }[] = [
  { harness: "Claude Code", pattern: /(?:^|\/)\bclaude\b(?:\s|$)/i },
  { harness: "OpenCode", pattern: /(?:^|\/)\bopencode\b(?:\s|$)/i },
  { harness: "Aider", pattern: /(?:^|\/)\baider\b(?:\s|$)/i },
  { harness: "Cursor", pattern: /(?:^|\/)\bcursor(?:-agent)?\b(?:\s|$)/i },
  { harness: "Gemini", pattern: /(?:^|\/)\bgemini\b(?:\s|$)/i },
  { harness: "OpenClaw", pattern: /(?:^|\/)\bopenclaw\b(?:\s|$)/i },
  { harness: "Hermes", pattern: /(?:^|\/)\bhermes\b(?:\s|$)/i },
];

const PROC_CACHE_TTL_MS = 5_000;
let procCache: { stamp: number; map: Map<number, ProcInfo> } | null = null;

function isWindows(): boolean {
  return process.platform === "win32";
}

export function resolveProcessCwd(pid: number): string | undefined {
  if (isWindows()) return undefined;
  try {
    const link = fs.readlinkSync(`/proc/${pid}/cwd`);
    return typeof link === "string" ? link : undefined;
  } catch {
    return undefined;
  }
}

export function snapshotProcesses(): Map<number, ProcInfo> {
  if (isWindows()) return new Map();
  const now = Date.now();
  if (procCache && now - procCache.stamp < PROC_CACHE_TTL_MS) return procCache.map;
  const map = new Map<number, ProcInfo>();
  try {
    const out = execSync("ps -eo pid=,ppid=,args=", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      map.set(pid, { pid, ppid: Number(m[2]), command: m[3] });
    }
  } catch {
    /* ps unavailable */
  }
  procCache = { stamp: now, map };
  return map;
}

export function clearProcessCache(): void {
  procCache = null;
}

export function resolveAgentIdentity(
  procs?: Map<number, ProcInfo>,
): { pid: number; ppid: number; harness: string } {
  const procMap = procs ?? snapshotProcesses();

  if (isWindows() && procMap.size === 0) {
    const envSession = process.env.PMD_SESSION;
    if (envSession) {
      try {
        const raw = fs.readFileSync(`.pipemd/crew/${envSession}.json`, "utf-8");
        const s = JSON.parse(raw);
        if (s && s.id) return { pid: s.pid, ppid: s.ppid, harness: s.harness };
      } catch { /* ignore */ }
    }
    return { pid: process.ppid, ppid: 0, harness: "unknown" };
  }

  let pid = process.ppid;
  const seen = new Set<number>();
  let depth = 0;
  let harnessPid = 0;
  let harness = "unknown";

  while (pid > 1 && !seen.has(pid) && depth < 40) {
    seen.add(pid);
    const info = procMap.get(pid);
    if (!info) break;
    for (const { harness: h, pattern } of HARNESS_PROCESS_PATTERNS) {
      if (pattern.test(info.command)) {
        harnessPid = pid;
        harness = h;
        break;
      }
    }
    if (harnessPid) break;
    pid = info.ppid;
    depth++;
  }

  const idPid = harnessPid || process.ppid;
  const ppid = procMap.get(idPid)?.ppid ?? 0;
  return { pid: idPid, ppid, harness };
}

export function resolvePassiveAgents(
  sessions: Array<{ pid: number; harness: string }>,
  procs: Map<number, ProcInfo>,
  projectRoot?: string,
): string[] {
  const knownPids = new Set(sessions.map((s) => s.pid));
  const matchByPid = new Map<number, string>();
  for (const [pid, info] of procs) {
    if (knownPids.has(pid)) continue;
    for (const { harness, pattern } of HARNESS_PROCESS_PATTERNS) {
      if (pattern.test(info.command)) {
        matchByPid.set(pid, harness);
        break;
      }
    }
  }
  const dominated = new Set<number>();
  for (const [pid, harness] of matchByPid) {
    let ancestor = procs.get(pid)?.ppid;
    while (ancestor && ancestor > 1) {
      if (matchByPid.get(ancestor) === harness) {
        dominated.add(pid);
        break;
      }
      ancestor = procs.get(ancestor)?.ppid;
    }
  }

  const keep: Array<{ pid: number; harness: string }> = [];
  for (const [pid, harness] of matchByPid) {
    if (dominated.has(pid)) continue;
    if (projectRoot && path.isAbsolute(projectRoot)) {
      let cwd = procs.get(pid)?.cwd;
      if (!cwd) cwd = resolveProcessCwd(pid);
      if (cwd && !cwd.startsWith(projectRoot)) continue;
    }
    keep.push({ pid, harness });
  }

  return keep
    .sort((a, b) => a.pid - b.pid)
    .map(({ pid, harness }) => `${harness} (pid ${pid})`);
}
