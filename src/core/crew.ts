// crew.ts — PipeMD Crew: multi-harness parallel-worker coordination layer.
//
// Model: Harness -> Coordinator -> sub-agents (workers).
// Each session owns exactly one JSON file under .pipemd/crew/, so there is no
// write contention and no locking — the per-file design sidesteps the daemon's
// last-write-wins concurrency model. PipeMD itself never registers a session;
// it is the neutral meta-coordinator that renders the union of all sessions.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { atomicWrite } from "./fs-utils.js";
import { isPidAlive } from "./json-utils.js";
import { PIPEMD_DIR as _PIPEMD_DIR, CREW_DIR as _CREW_DIR } from "./paths.js";

export type CrewRole = "coordinator" | "worker";

export interface CrewClaim {
  path: string;
  claimedAt: string;
  note?: string;
}

export interface CrewSession {
  schema: number;
  id: string;
  role: CrewRole;
  harness: string;
  label?: string;
  pid: number;
  ppid: number;
  coordinatorId: string | null;
  claimedFiles: CrewClaim[];
  note?: string;
  startedAt: string;
  lastHeartbeat: string;
  cwd: string;
  _remote?: boolean;
  _origin?: string;
}

export const CREW_SCHEMA = 1;
export const PIPEMD_DIR = _PIPEMD_DIR;
export const CREW_DIR = _CREW_DIR;
export const DEFAULT_STALE_MS = 90_000;
/** Grace window before a dead-PID session is reaped — heartbeat outranks PID. */
export const PID_GRACE_MS = 15_000;

/**
 * Process-name patterns used to attribute an OS process to a known harness.
 * Patterns anchor to the binary name at a word boundary to avoid false
 * positives (e.g. matching "claude" inside a file path argument).
 */
export const HARNESS_PROCESS_PATTERNS: { harness: string; pattern: RegExp }[] = [
  { harness: "Claude Code", pattern: /(?:^|\/)\bclaude\b(?:\s|$)/i },
  { harness: "OpenCode", pattern: /(?:^|\/)\bopencode\b(?:\s|$)/i },
  { harness: "Aider", pattern: /(?:^|\/)\baider\b(?:\s|$)/i },
  { harness: "Cursor", pattern: /(?:^|\/)\bcursor(?:-agent)?\b(?:\s|$)/i },
  { harness: "Gemini", pattern: /(?:^|\/)\bgemini\b(?:\s|$)/i },
  { harness: "OpenClaw", pattern: /(?:^|\/)\bopenclaw\b(?:\s|$)/i },
  { harness: "Hermes", pattern: /(?:^|\/)\bhermes\b(?:\s|$)/i },
];

// ---------------------------------------------------------------------------
// Filesystem layer — one JSON file per session, atomic writes.
// ---------------------------------------------------------------------------

export function crewSessionPath(id: string): string {
  return path.join(CREW_DIR, `${id}.json`);
}

export function generateSessionId(): string {
  return "cr_" + crypto.randomBytes(6).toString("hex");
}

export function ensureCrewDir(): void {
  fs.mkdirSync(CREW_DIR, { recursive: true });
}

export function isPipemdProject(): boolean {
  return fs.existsSync(path.join(PIPEMD_DIR, "config.yml"));
}

export function readSession(id: string): CrewSession | null {
  try {
    const raw = fs.readFileSync(crewSessionPath(id), "utf-8");
    const s = JSON.parse(raw) as CrewSession;
    return s && s.id ? s : null;
  } catch {
    return null;
  }
}

export function writeSessionAtomic(session: CrewSession): void {
  ensureCrewDir();
  const target = crewSessionPath(session.id);
  atomicWrite(target, JSON.stringify(session, null, 2) + "\n");
}

/** Read every session file, silently skipping malformed ones. Merges remote. */
export function listSessions(): CrewSession[] {
  let files: string[];
  try {
    files = fs.readdirSync(CREW_DIR);
  } catch {
    files = [];
  }
  const out: CrewSession[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(CREW_DIR, f), "utf-8")) as CrewSession;
      if (s && s.id) out.push(s);
    } catch {
      /* malformed file — ignore, not throw */
    }
  }
  out.push(...remoteSessionsCache);
  return out;
}

export function deleteSession(id: string): void {
  try {
    fs.unlinkSync(crewSessionPath(id));
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Remote session cache — populated by the relay client (net/daemon-client).
// ---------------------------------------------------------------------------

let remoteSessionsCache: CrewSession[] = [];

export function setRemoteSessions(sessions: CrewSession[]): void {
  remoteSessionsCache = sessions;
}

export function getRemoteSessions(): CrewSession[] {
  return remoteSessionsCache;
}

export function clearRemoteSessions(): void {
  remoteSessionsCache = [];
}

// ---------------------------------------------------------------------------
// Liveness & staleness.
// ---------------------------------------------------------------------------

// Re-exported for consumers that import isPidAlive from crew.ts.
export { isPidAlive } from "./json-utils.js";

/**
 * A session is stale when its heartbeat is older than `staleMs`, or when its
 * process is dead AND it has had a short grace window (PID_GRACE_MS) without a
 * heartbeat. A fresh heartbeat always outranks a dead-PID guess, since PID
 * attribution via the ancestry walk can be imperfect. A coordinator with at
 * least one live worker survives a stale heartbeat (it may sit idle).
 */
export function isSessionStale(
  session: CrewSession,
  staleMs: number = DEFAULT_STALE_MS,
  now: number = Date.now(),
  liveWorkerCount: number = 0,
): boolean {
  const hb = Date.parse(session.lastHeartbeat);
  const hbAge = Number.isNaN(hb) ? Infinity : now - hb;
  const coordHasCrew = session.role === "coordinator" && liveWorkerCount > 0;

  if (hbAge > staleMs) return !coordHasCrew;
  if (hbAge > PID_GRACE_MS && !isPidAlive(session.pid)) return !coordHasCrew;
  return false;
}

/** Delete stale session files. Returns the ids that were reaped. */
export function reapStaleSessions(staleMs: number = DEFAULT_STALE_MS): string[] {
  const sessions = listSessions();
  const now = Date.now();

  const liveWorkersByCoord = new Map<string, number>();
  for (const s of sessions) {
    if (s.role === "worker" && s.coordinatorId && isPidAlive(s.pid)) {
      liveWorkersByCoord.set(s.coordinatorId, (liveWorkersByCoord.get(s.coordinatorId) || 0) + 1);
    }
  }

  const sessionIds = new Set(sessions.map((s) => s.id));
  const reaped: string[] = [];
  for (const s of sessions) {
    if (s.role === "worker" && s.coordinatorId && !sessionIds.has(s.coordinatorId)) {
      deleteSession(s.id);
      reaped.push(s.id);
      continue;
    }
    const liveWorkers = s.role === "coordinator" ? liveWorkersByCoord.get(s.id) || 0 : 0;
    if (isSessionStale(s, staleMs, now, liveWorkers)) {
      deleteSession(s.id);
      reaped.push(s.id);
    }
  }
  return reaped;
}

// ---------------------------------------------------------------------------
// Process tree — used to attribute a `pmd` invocation to a harness.
// ---------------------------------------------------------------------------

export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
  cwd?: string;
}

/** TTL-based cache to avoid calling `ps` on every render cycle. */
const PROC_CACHE_TTL_MS = 5_000;
let procCache: { stamp: number; map: Map<number, ProcInfo> } | null = null;

function isWindows(): boolean {
  return process.platform === "win32";
}

function resolveProcessCwd(pid: number): string | undefined {
  if (isWindows()) return undefined;
  try {
    const target = `/proc/${pid}/cwd`;
    const link = fs.readlinkSync(target);
    return typeof link === "string" ? link : undefined;
  } catch {
    return undefined;
  }
}

/** Snapshot the process table (best effort; empty map on failure). Cached. */
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
    /* ps unavailable — passive process layer degrades to empty */
  }
  procCache = { stamp: now, map };
  return map;
}

/** Clear the process snapshot cache (useful in tests). */
export function clearProcessCache(): void {
  procCache = null;
}

/**
 * Walk the ancestry of the calling agent to find the nearest harness process.
 * Hooks invoke `pmd` through an ephemeral shell, so `process.ppid` is unstable;
 * the harness process pid is stable and is used as the session identity.
 *
 * On Windows (no ps), falls back to PMD_SESSION env or the parent PID with
 * "unknown" harness attribution.
 */
export function resolveAgentIdentity(
  procs?: Map<number, ProcInfo>,
): { pid: number; ppid: number; harness: string } {
  const procMap = procs ?? snapshotProcesses();

  if (isWindows() && procMap.size === 0) {
    const envSession = process.env.PMD_SESSION;
    if (envSession) {
      const s = readSession(envSession);
      if (s) return { pid: s.pid, ppid: s.ppid, harness: s.harness };
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

// ---------------------------------------------------------------------------
// Session lifecycle.
// ---------------------------------------------------------------------------

export interface JoinOptions {
  role?: CrewRole;
  coordinatorId?: string;
  harness?: string;
  label?: string;
}

/**
 * Register (or refresh) a session for the calling agent.
 * Default role is `coordinator` — one coordinator per harness. Sub-agents pass
 * `--role worker` (or set PMD_CREW_ROLE=worker) and are linked to a coordinator.
 */
export function joinSession(opts: JoinOptions): CrewSession {
  const identity = resolveAgentIdentity();
  const sessions = listSessions();
  const harness = opts.harness || identity.harness;

  let role: CrewRole;
  if (opts.role) {
    role = opts.role;
  } else if (process.env.PMD_CREW_ROLE === "worker" || process.env.PMD_CREW_ROLE === "coordinator") {
    role = process.env.PMD_CREW_ROLE as CrewRole;
  } else {
    role = "coordinator";
  }

  let coordinatorId: string | null = null;
  if (role === "worker") {
    coordinatorId =
      opts.coordinatorId ??
      process.env.PMD_CREW_COORDINATOR ??
      sessions.find((s) => s.role === "coordinator" && s.harness === harness)?.id ??
      null;
  }

  // Reuse an existing session: explicit PMD_SESSION, or the coordinator that
  // already owns this harness pid. Workers joined explicitly get fresh ids so
  // multiple sub-agents can share one harness process.
  let existing: CrewSession | undefined;
  if (process.env.PMD_SESSION) {
    const sessionId = process.env.PMD_SESSION;
    if (!/^cr_[0-9a-f]+$/.test(sessionId)) {
      throw new Error(`Invalid PMD_SESSION format: ${sessionId}`);
    }
    existing = readSession(sessionId) ?? undefined;
  }
  if (!existing && role === "coordinator") {
    const candidate = sessions.find((s) => s.pid === identity.pid && s.role === "coordinator");
    if (candidate && !isPidAlive(candidate.pid)) {
      deleteSession(candidate.id);
    } else {
      existing = candidate;
    }
  }

  const now = new Date().toISOString();
  const id = existing?.id ?? generateSessionId();
  const session: CrewSession = {
    schema: CREW_SCHEMA,
    id,
    role,
    harness,
    label: opts.label ?? existing?.label,
    pid: identity.pid,
    ppid: identity.ppid,
    coordinatorId,
    claimedFiles: existing?.claimedFiles ?? [],
    note: existing?.note,
    startedAt: existing?.startedAt ?? now,
    lastHeartbeat: now,
    cwd: process.cwd(),
  };
  writeSessionAtomic(session);
  return session;
}

/** Find the session a write command applies to (PMD_SESSION env, then pid). */
export function resolveActiveSession(): CrewSession | null {
  const envId = process.env.PMD_SESSION;
  if (envId) {
    const s = readSession(envId);
    if (s) return s;
  }
  const { pid } = resolveAgentIdentity();
  return listSessions().find((s) => s.pid === pid) ?? null;
}

/** Resolve the active session, auto-joining a coordinator if none exists. */
export function resolveOrJoin(): CrewSession {
  return resolveActiveSession() ?? joinSession({});
}

export function touchHeartbeat(session: CrewSession): CrewSession {
  session.lastHeartbeat = new Date().toISOString();
  writeSessionAtomic(session);
  return session;
}

/** Normalize a path argument to a forward-slash repo-relative path. */
export function toRepoRelative(file: string): string {
  const rel = path.relative(process.cwd(), path.resolve(file));
  return rel.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Conflict detection.
// ---------------------------------------------------------------------------

export interface CrewConflict {
  path: string;
  sessionIds: string[];
}

/** A conflict is any file claimed by more than one live session. */
export function findConflicts(sessions: CrewSession[]): CrewConflict[] {
  const byPath = new Map<string, Set<string>>();
  for (const s of sessions) {
    for (const c of s.claimedFiles || []) {
      const set = byPath.get(c.path) ?? new Set<string>();
      set.add(s.id);
      byPath.set(c.path, set);
    }
  }
  const out: CrewConflict[] = [];
  for (const [p, set] of byPath) {
    if (set.size > 1) out.push({ path: p, sessionIds: [...set] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON status — structured crew data for TUI plugin consumption.
// ---------------------------------------------------------------------------

export interface CrewStatusJson {
  sessions: Array<{
    id: string;
    role: CrewRole;
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
}

function resolvePassiveAgents(
  sessions: CrewSession[],
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

  const root = projectRoot && path.isAbsolute(projectRoot) ? projectRoot : undefined;
  const keep: Array<{ pid: number; harness: string }> = [];
  for (const [pid, harness] of matchByPid) {
    if (dominated.has(pid)) continue;
    if (root) {
      let cwd = procs.get(pid)?.cwd;
      if (!cwd) cwd = resolveProcessCwd(pid);
      if (cwd && !cwd.startsWith(root)) continue;
    }
    keep.push({ pid, harness });
  }

  return keep
    .sort((a, b) => a.pid - b.pid)
    .map(({ pid, harness }) => `${harness} (pid ${pid})`);
}

function resolveUncommittedFiles(): string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean).map((l) => l.slice(3));
  } catch {
    return [];
  }
}

export function getStatusJson(): CrewStatusJson {
  const sessions = listSessions();
  const conflicts = findConflicts(sessions);
  const harnesses = new Set(sessions.map((s) => s.harness));

  const passive: string[] = [];
  try {
    const procs = snapshotProcesses();
    passive.push(...resolvePassiveAgents(sessions, procs, process.cwd()));
  } catch { /* ps unavailable */ }

  const uncommitted = resolveUncommittedFiles();

  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      role: s.role,
      harness: s.harness,
      label: s.label,
      claimedFiles: s.claimedFiles.map((c) => c.path),
      note: s.note,
      lastHeartbeat: s.lastHeartbeat,
    })),
    conflicts,
    harnessCount: harnesses.size,
    sessionCount: sessions.length,
    passiveAgents: passive.slice(0, 8),
    uncommittedFiles: uncommitted.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Rendering — the `<!-- pmd: crew -->` block. Heavy logic lives here (TS) so it
// is unit-testable; scripts/Shared/crew/crew.sh is just a thin delegator.
// ---------------------------------------------------------------------------

function claimList(s: CrewSession): string {
  return s.claimedFiles.length
    ? s.claimedFiles.map((c) => c.path).join(", ")
    : "";
}

function renderPassiveLayer(sessions: CrewSession[], procs: Map<number, ProcInfo>): string[] {
  const lines: string[] = [];
  const observed = resolvePassiveAgents(sessions, procs, process.cwd());
  const dirty = resolveUncommittedFiles();

  if (observed.length) {
    lines.push(`Passive — agents running without a crew session: ${observed.slice(0, 8).join(", ")}`);
  }
  if (dirty.length) {
    const shown = dirty.slice(0, 10).join(", ");
    const more = dirty.length > 10 ? ` … +${dirty.length - 10} more` : "";
    lines.push(`Passive — uncommitted files: ${shown}${more}`);
  }
  return lines;
}

/** Render the crew coordination block as plain text (the injector fences it). */
export function renderCrewBlock(opts: { maxLines?: number; reap?: boolean } = {}): string {
  if (opts.reap !== false) reapStaleSessions();

  const sessions = listSessions();
  const conflicts = findConflicts(sessions);
  const lines: string[] = [];
  const hhmmss = new Date().toTimeString().slice(0, 8);
  const harnesses = new Set(sessions.map((s) => s.harness));

  lines.push(
    `👥 Crew — ${harnesses.size} harness(es), ${sessions.length} active session(s) · updated ${hhmmss}`,
  );

  for (const c of conflicts) {
    const who = c.sessionIds
      .map((id) => {
        const s = sessions.find((x) => x.id === id);
        return s ? `${s.id} (${s.harness})` : id;
      })
      .join(" and ");
    lines.push(`⚠️ CONFLICT: ${c.path} claimed by ${who}`);
  }

  const conflictPaths = new Set(conflicts.map((c) => c.path));
  const coordinators = sessions.filter((s) => s.role === "coordinator");
  const workers = sessions.filter((s) => s.role === "worker");

  if (sessions.length === 0) {
    lines.push("");
    lines.push("_No active PipeMD crew sessions._");
  }

  for (const coord of coordinators) {
    const remoteTag = coord._remote && coord._origin ? ` · remote: ${coord._origin}` : "";
    lines.push("");
    lines.push(`▸ ${coord.harness}  (coordinator ${coord.id} · pid ${coord.pid}${remoteTag})`);
    if (coord.note) lines.push(`    · note: ${coord.note}`);
    const cc = claimList(coord);
    if (cc) lines.push(`    · claimed: ${cc}`);

    const kids = workers.filter((w) => w.coordinatorId === coord.id);
    kids.forEach((w, i) => {
      const branch = i === kids.length - 1 ? "└─" : "├─";
      const claimed = claimList(w);
      const claimStr = claimed ? `claimed: ${claimed}` : "no claim";
      const noteStr = w.note ? `  "${w.note}"` : "";
      const flag = w.claimedFiles.some((c) => conflictPaths.has(c.path)) ? "  ⚠️" : "";
      const rmt = w._remote && w._origin ? ` · remote: ${w._origin}` : "";
      lines.push(`    ${branch} ${w.label || w.id}  ${claimStr}${noteStr}${flag}${rmt}`);
    });
  }

  const unattached = workers.filter(
    (w) => !w.coordinatorId || !coordinators.some((c) => c.id === w.coordinatorId),
  );
  if (unattached.length) {
    lines.push("");
    lines.push("▸ Unattached workers (no coordinator):");
    for (const w of unattached) {
      const claimed = claimList(w);
      lines.push(`    - ${w.harness}/${w.label || w.id}  ${claimed ? `claimed: ${claimed}` : "no claim"}`);
    }
  }

  const procs = snapshotProcesses();
  const passive = renderPassiveLayer(sessions, procs);
  if (passive.length) {
    lines.push("");
    lines.push(...passive);
  }

  const max = opts.maxLines && opts.maxLines > 0 ? opts.maxLines : 60;
  if (lines.length > max) {
    const head = lines.slice(0, max);
    head.push(`… (${lines.length - max} more lines truncated — raise PMD_MAX_CREW)`);
    return head.join("\n");
  }
  return lines.join("\n");
}
