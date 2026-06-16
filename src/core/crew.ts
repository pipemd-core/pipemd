import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWrite } from "./fs-utils.js";
import { isPidAlive } from "./json-utils.js";
import { PIPEMD_DIR as _PIPEMD_DIR, CREW_DIR as _CREW_DIR } from "./paths.js";
import { resolveAgentIdentity } from "./crew-process.js";
import { log, errMsg } from "./logger.js";
import { TtlCache } from "./ttl-cache.js";
export { resolveAgentIdentity } from "./crew-process.js";
export { renderCrewBlock, getStatusJson } from "./crew-render.js";

export type CrewRole = "coordinator" | "worker";

interface CrewClaim {
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
  sources?: string[];
  startedAt: string;
  lastHeartbeat: string;
  cwd: string;
  _remote?: boolean;
  _origin?: string;
}

const CREW_SCHEMA = 1;
export const PIPEMD_DIR = _PIPEMD_DIR;
const CREW_DIR = _CREW_DIR;
export const DEFAULT_STALE_MS = 90_000;
export const PID_GRACE_MS = 15_000;

// ---------------------------------------------------------------------------
// Filesystem layer — one JSON file per session, atomic writes.
// ---------------------------------------------------------------------------

function crewSessionPath(id: string): string {
  return path.join(CREW_DIR, `${id}.json`);
}

export function generateSessionId(): string {
  return "cr_" + crypto.randomBytes(6).toString("hex");
}

function ensureCrewDir(): void {
  fs.mkdirSync(CREW_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CREW_DIR, 0o700); } catch (err: unknown) { log.debug(`ensureCrewDir chmod failed: ${errMsg(err)}`); }
}

export function isPipemdProject(): boolean {
  return fs.existsSync(path.join(PIPEMD_DIR, "config.yml"));
}

export function readSession(id: string): CrewSession | null {
  try {
    const raw = fs.readFileSync(crewSessionPath(id), "utf-8");
    const s = JSON.parse(raw) as CrewSession;
    return s && s.id ? s : null;
  } catch (err: unknown) {
    log.debug(`readSession failed: ${errMsg(err)}`);
    return null;
  }
}

export function writeSessionAtomic(session: CrewSession): void {
  ensureCrewDir();
  const target = crewSessionPath(session.id);
  atomicWrite(target, JSON.stringify(session, null, 2) + "\n");
  try { fs.chmodSync(target, 0o600); } catch (err: unknown) { log.debug(`writeSessionAtomic chmod failed: ${errMsg(err)}`); }
  sessionListCache.invalidate();
}

export function deleteSession(id: string): void {
  try {
    fs.unlinkSync(crewSessionPath(id));
  } catch (err: unknown) { log.debug(`deleteSession unlink failed: ${errMsg(err)}`); }
}

// ---------------------------------------------------------------------------
// Remote session cache — populated by the relay client (net/daemon-client).
// ---------------------------------------------------------------------------

let remoteSessionsCache: CrewSession[] = [];
const sessionListCache = new TtlCache<CrewSession[]>(2_000);

export function invalidateSessionListCache(): void {
  sessionListCache.invalidate();
}

export function setRemoteSessions(sessions: CrewSession[]): void {
  remoteSessionsCache = sessions;
  sessionListCache.invalidate();
}

export function getRemoteSessions(): CrewSession[] {
  return remoteSessionsCache;
}

export function clearRemoteSessions(): void {
  remoteSessionsCache = [];
  sessionListCache.invalidate();
}

export function listSessions(): CrewSession[] {
  const cached = sessionListCache.get();
  if (cached) return [...cached, ...remoteSessionsCache];
  let files: string[];
  try {
    files = fs.readdirSync(CREW_DIR);
  } catch (err: unknown) {
    log.debug(`listSessions readdir failed: ${errMsg(err)}`);
    files = [];
  }
  const out: CrewSession[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(CREW_DIR, f), "utf-8")) as CrewSession;
      if (s && s.id) out.push(s);
    } catch (err: unknown) { log.debug(`listSessions parse failed: ${errMsg(err)}`); }
  }
  sessionListCache.set(out);
  return [...out, ...remoteSessionsCache];
}

// ---------------------------------------------------------------------------
// Liveness & staleness.
// ---------------------------------------------------------------------------

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
// Conflict detection.
// ---------------------------------------------------------------------------

export interface CrewConflict {
  path: string;
  sessionIds: string[];
}

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
// Session lifecycle.
// ---------------------------------------------------------------------------

export interface JoinOptions {
  role?: CrewRole;
  coordinatorId?: string;
  harness?: string;
  label?: string;
  sources?: string[];
}

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
    sources: opts.sources ?? existing?.sources,
    startedAt: existing?.startedAt ?? now,
    lastHeartbeat: now,
    cwd: process.cwd(),
  };
  writeSessionAtomic(session);
  return session;
}

export function resolveActiveSession(): CrewSession | null {
  const envId = process.env.PMD_SESSION;
  if (envId) {
    const s = readSession(envId);
    if (s) return s;
  }
  const { pid } = resolveAgentIdentity();
  return listSessions().find((s) => s.pid === pid) ?? null;
}

export function resolveOrJoin(): CrewSession {
  return resolveActiveSession() ?? joinSession({});
}

export function touchHeartbeat(session: CrewSession): CrewSession {
  session.lastHeartbeat = new Date().toISOString();
  writeSessionAtomic(session);
  return session;
}

export function toRepoRelative(file: string): string {
  const rel = path.relative(process.cwd(), path.resolve(file));
  return rel.split(path.sep).join("/");
}
