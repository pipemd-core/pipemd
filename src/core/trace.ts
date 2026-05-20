import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { listSessions } from "./crew.js";
import type { CrewSession } from "./crew.js";
import { INJECTED_DIR } from "./dedup.js";
import { CREW_DIR, INJECTION_LOG_DIR, TUI_STATS_FILE, INJECT_STATS_FILE } from "./paths.js";
import { tryReadJson, isPidAlive, readInjectStats, formatTimeAgo } from "./json-utils.js";

export interface TraceSession {
  id: string;
  role: "coordinator" | "worker";
  harness: string;
  label?: string;
  pid: number;
  coordinatorId: string | null;
  claimedFiles: Array<{ path: string; claimedAt: string; note?: string }>;
  note?: string;
  startedAt: string;
  lastHeartbeat: string;
  alive: boolean;
  staleMs: number;
  dedupSources: Record<string, { hash: string; timestamp: number }>;
  injectionCount: number;
  dedupCount: number;
  lastEvent?: {
    trigger: string;
    tool: string;
    file: string;
    result: string;
    tokens: number;
    ts: string;
  };
  children: TraceSession[];
}

export interface TraceConflict {
  path: string;
  sessionIds: string[];
  sessions: Array<{ id: string; role: string; harness: string }>;
}

export interface TraceEvent {
  ts: string;
  trigger: string;
  tool: string;
  file: string;
  result: string;
  tokens: number;
  sessionId?: string;
  payload?: string;
}

export interface TracePayload {
  id: number;
  timestamp: string;
  content: string;
  meta?: {
    session?: string;
    trigger?: string;
    tool?: string;
    file?: string;
  };
}

export interface TraceData {
  sessions: TraceSession[];
  conflicts: TraceConflict[];
  events: TraceEvent[];
  payloads: TracePayload[];
  orphanedDedup: string[];
  totalInjected: number;
  totalDedup: number;
  timestamp: number;
}

export interface LockEntry {
  path: string;
  sessionId: string;
  role: string;
  harness: string;
  claimedAt: string;
  note?: string;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function readDedupStore(sessionId: string): Record<string, { hash: string; timestamp: number }> {
  const p = path.join(INJECTED_DIR, `${sessionId}.json`);
  const data = tryReadJson(p);
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  return {};
}

function readTuiEvents(): any[] {
  const stats = tryReadJson(TUI_STATS_FILE);
  if (stats && Array.isArray(stats.events)) return stats.events;
  return [];
}

function readPayloads(maxPayloads: number): TracePayload[] {
  let files: string[];
  try {
    files = fs.readdirSync(INJECTION_LOG_DIR).filter(f => /^\d+\.txt$/.test(f));
  } catch {
    return [];
  }
  files.sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    return nb - na;
  });
  files = files.slice(0, maxPayloads);
  const payloads: TracePayload[] = [];
  for (const f of files) {
    const p = path.join(INJECTION_LOG_DIR, f);
    let raw: string;
    try {
      raw = fs.readFileSync(p, "utf-8");
    } catch {
      continue;
    }
    const id = parseInt(f, 10);
    const stat = fs.statSync(p);
    let meta: TracePayload["meta"];
    let content = raw;
    const firstNewline = raw.indexOf("\n");
    if (firstNewline !== -1) {
      const firstLine = raw.slice(0, firstNewline);
      const metaMatch = firstLine.match(/^\[pmd-meta\s+(.*)\]$/);
      if (metaMatch) {
        const kvStr = metaMatch[1];
        meta = {};
        const sessionM = kvStr.match(/session=(\S+)/);
        if (sessionM) meta.session = sessionM[1];
        const triggerM = kvStr.match(/trigger=(\S+)/);
        if (triggerM) meta.trigger = triggerM[1];
        const toolM = kvStr.match(/tool=(\S+)/);
        if (toolM) meta.tool = toolM[1];
        const fileM = kvStr.match(/file=(\S+)/);
        if (fileM) meta.file = fileM[1];
        content = raw.slice(firstNewline + 1);
      }
    }
    payloads.push({
      id,
      timestamp: stat.mtime.toISOString(),
      content,
      meta: meta || undefined,
    });
  }
  return payloads;
}

function readOrphanedDedup(crewIds: Set<string>): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(INJECTED_DIR).filter(f => f.endsWith(".json"));
  } catch {
    return [];
  }
  const orphaned: string[] = [];
  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    if (!crewIds.has(id)) orphaned.push(id);
  }
  return orphaned;
}

function enrichSession(
  raw: CrewSession,
  events: any[],
  crewMap: Map<string, CrewSession>,
): TraceSession {
  const alive = isPidAlive(raw.pid);
  const staleMs = Date.now() - new Date(raw.lastHeartbeat).getTime();
  const dedupSources = readDedupStore(raw.id);

  let injectionCount = 0;
  let dedupCount = 0;
  for (const entry of Object.values(dedupSources)) {
    injectionCount++;
  }

  for (const ev of events) {
    if (ev.session === raw.id || (ev.session === undefined && raw.role === "coordinator")) {
      if (ev.result === "dedup") dedupCount++;
    }
  }

  const sessionEvents = events.filter(
    e => e.session === raw.id || (e.session === undefined && raw.role === "coordinator"),
  );
  let lastEvent: TraceSession["lastEvent"];
  if (sessionEvents.length > 0) {
    const ev = sessionEvents[sessionEvents.length - 1];
    lastEvent = {
      trigger: ev.trigger || "",
      tool: ev.tool || "",
      file: ev.file || "",
      result: ev.result || "",
      tokens: ev.tokens || 0,
      ts: ev.ts || "",
    };
  }

  return {
    id: raw.id,
    role: raw.role,
    harness: raw.harness,
    label: raw.label,
    pid: raw.pid,
    coordinatorId: raw.coordinatorId,
    claimedFiles: raw.claimedFiles || [],
    note: raw.note,
    startedAt: raw.startedAt,
    lastHeartbeat: raw.lastHeartbeat,
    alive,
    staleMs,
    dedupSources,
    injectionCount,
    dedupCount,
    lastEvent,
    children: [],
  };
}

function findConflicts(sessions: TraceSession[]): TraceConflict[] {
  const fileMap = new Map<string, TraceSession[]>();
  for (const s of sessions) {
    for (const claim of s.claimedFiles) {
      const existing = fileMap.get(claim.path) || [];
      existing.push(s);
      fileMap.set(claim.path, existing);
    }
  }
  const conflicts: TraceConflict[] = [];
  for (const [filePath, sess] of fileMap) {
    if (sess.length > 1) {
      conflicts.push({
        path: filePath,
        sessionIds: sess.map(s => s.id),
        sessions: sess.map(s => ({ id: s.id, role: s.role, harness: s.harness })),
      });
    }
  }
  return conflicts;
}

function flattenAllSessions(tree: TraceSession[]): TraceSession[] {
  const result: TraceSession[] = [];
  for (const s of tree) {
    result.push(s);
    result.push(...flattenAllSessions(s.children));
  }
  return result;
}

export function resolveTraceData(opts?: { maxPayloads?: number }): TraceData {
  const maxPayloads = opts?.maxPayloads ?? 10;
  const rawSessions = listSessions();
  const events = readTuiEvents();
  const stats = readInjectStats(INJECT_STATS_FILE);
  const payloads = readPayloads(maxPayloads);
  const crewIds = new Set(rawSessions.map(s => s.id));
  const orphanedDedup = readOrphanedDedup(crewIds);

  const crewMap = new Map<string, CrewSession>();
  for (const s of rawSessions) crewMap.set(s.id, s);

  const enriched = rawSessions.map(s => enrichSession(s, events, crewMap));
  const enrichedMap = new Map<string, TraceSession>();
  for (const s of enriched) enrichedMap.set(s.id, s);

  const roots: TraceSession[] = [];
  for (const s of enriched) {
    if (s.coordinatorId && enrichedMap.has(s.coordinatorId)) {
      enrichedMap.get(s.coordinatorId)!.children.push(s);
    } else {
      roots.push(s);
    }
  }

  const allFlat = flattenAllSessions(roots);
  const conflicts = findConflicts(allFlat);

  return {
    sessions: roots,
    conflicts,
    events: events.map(e => ({
      ts: e.ts || "",
      trigger: e.trigger || "",
      tool: e.tool || "",
      file: e.file || "",
      result: e.result || "",
      tokens: e.tokens || 0,
      sessionId: e.session,
      payload: e.payload,
    })),
    payloads,
    orphanedDedup,
    totalInjected: stats.delivered,
    totalDedup: stats.dedup,
    timestamp: Date.now(),
  };
}

export function resolveLockMap(sessions: TraceSession[]): LockEntry[] {
  const flat = flattenAllSessions(sessions);
  const entries: LockEntry[] = [];
  for (const s of flat) {
    for (const claim of s.claimedFiles) {
      entries.push({
        path: claim.path,
        sessionId: s.id,
        role: s.role,
        harness: s.harness,
        claimedAt: claim.claimedAt,
        note: claim.note,
      });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

export function renderTraceTree(data: TraceData): string {
  const lines: string[] = [];

  function renderSession(s: TraceSession, prefix: string, isLast: boolean): void {
    const bullet = chalk.cyan("●");
    const connector = isLast ? "└── " : "├── ";
    const aliveStr = s.alive ? chalk.green("↑ live") : chalk.red("↓ dead");
    const roleStr = s.role === "coordinator" ? "coord" : "worker";
    const short = shortId(s.id);
    const header = `${prefix}${connector}${bullet} ${chalk.bold(s.harness)}  ${chalk.gray(short)}  ${roleStr}  pid ${s.pid}  ${aliveStr}`;

    if (s.role === "worker") {
      const ago = formatTimeAgo(s.lastHeartbeat);
      lines.push(`${header}  ${chalk.gray(ago)}`);
    } else {
      lines.push(header);
    }

    const childPrefix = prefix + (isLast ? "    " : "│   ");
    const indent = childPrefix + "│  ";

    const claims = s.claimedFiles.map(c => c.path);
    lines.push(`${indent}claimed: ${claims.length ? claims.join(", ") : chalk.gray("(none)")}`);

    if (s.note) {
      lines.push(`${indent}note: ${chalk.yellow(`"${s.note}"`)}`);
    }

    const dedupKeys = Object.keys(s.dedupSources);
    if (dedupKeys.length > 0) {
      const dedupStr = dedupKeys.map(k => `${k}${chalk.green("✓")}`).join(" ");
      lines.push(`${indent}dedup: ${dedupStr}`);
    }

    lines.push(
      `${indent}injections: ${s.injectionCount} delivered · ${s.dedupCount} deduped`,
    );

    if (s.lastEvent) {
      const tokStr = s.lastEvent.tokens > 0 ? ` +${s.lastEvent.tokens} tok` : "";
      const ago = s.lastEvent.ts ? formatTimeAgo(s.lastEvent.ts) : "";
      lines.push(
        `${indent}last: ${chalk.blue(s.lastEvent.trigger)}  ${chalk.magenta(s.lastEvent.result)}${tokStr}  ${s.lastEvent.file}  ${chalk.gray(ago)}`,
      );
    }

    if (s.children.length > 0) {
      lines.push(`${childPrefix}│`);
    } else {
      lines.push("");
    }

    for (let i = 0; i < s.children.length; i++) {
      renderSession(s.children[i], childPrefix, i === s.children.length - 1);
    }
  }

  if (data.sessions.length === 0) {
    lines.push(chalk.gray("No active sessions"));
  }

  for (let i = 0; i < data.sessions.length; i++) {
    renderSession(data.sessions[i], "", i === data.sessions.length - 1);
  }

  if (data.conflicts.length > 0) {
    lines.push("");
    lines.push(chalk.red.bold("⚠ Conflicts:"));
    for (const c of data.conflicts) {
      lines.push(`  ${chalk.red(c.path)} → ${c.sessionIds.map(id => chalk.gray(shortId(id))).join(", ")}`);
    }
  }

  if (data.orphanedDedup.length > 0) {
    lines.push("");
    lines.push(chalk.yellow("Orphaned dedup stores: " + data.orphanedDedup.join(", ")));
  }

  lines.push("");
  lines.push(
    `Totals: ${chalk.green(String(data.totalInjected))} injected · ${chalk.yellow(String(data.totalDedup))} deduped`,
  );

  return lines.join("\n");
}

export function renderTimeline(events: TraceEvent[], sessions: TraceSession[]): string {
  if (events.length === 0) return chalk.gray("No events recorded");

  const sessionMap = new Map<string, TraceSession>();
  for (const s of flattenAllSessions(sessions)) sessionMap.set(s.id, s);

  const lines: string[] = [chalk.bold("Timeline:"), ""];

  for (const ev of events) {
    const time = ev.ts ? formatTimeAgo(ev.ts) : "?";
    const sid = ev.sessionId ? shortId(ev.sessionId) : "?";
    const sess = ev.sessionId ? sessionMap.get(ev.sessionId) : undefined;
    const harnessTag = sess ? chalk.gray(`[${sess.harness}]`) : "";
    const resultColor = ev.result === "injected" ? chalk.green : ev.result === "dedup" ? chalk.yellow : chalk.gray;
    const tokStr = ev.tokens > 0 ? chalk.cyan(`+${ev.tokens} tok`) : "";

    lines.push(
      `${chalk.gray(time.padEnd(10))} ${chalk.gray(sid.padEnd(8))} ${harnessTag.padEnd(14)} ${chalk.blue(ev.trigger.padEnd(14))} ${resultColor(ev.result).padEnd(10)} ${ev.file} ${tokStr}`,
    );
  }

  return lines.join("\n");
}

export function renderLockMap(locks: LockEntry[]): string {
  if (locks.length === 0) return chalk.gray("No files claimed");

  const lines: string[] = [chalk.bold("Lock Map:"), ""];

  for (const lock of locks) {
    const short = shortId(lock.sessionId);
    const roleTag = lock.role === "coordinator" ? chalk.cyan("coord") : chalk.magenta("worker");
    const ago = formatTimeAgo(lock.claimedAt);
    const note = lock.note ? chalk.yellow(` — ${lock.note}`) : "";
    lines.push(
      `  ${chalk.white(lock.path)}  ${chalk.gray(short)}  ${roleTag}  ${lock.harness}  ${chalk.gray(ago)}${note}`,
    );
  }

  return lines.join("\n");
}

export function renderPayloads(payloads: TracePayload[]): string {
  if (payloads.length === 0) return chalk.gray("No payloads recorded");

  const lines: string[] = [chalk.bold(`Last ${payloads.length} Payloads:`), ""];

  for (const p of payloads) {
    const ago = formatTimeAgo(p.timestamp);
    const metaParts: string[] = [];
    if (p.meta?.session) metaParts.push(`session=${shortId(p.meta.session)}`);
    if (p.meta?.trigger) metaParts.push(`trigger=${p.meta.trigger}`);
    if (p.meta?.tool) metaParts.push(`tool=${p.meta.tool}`);
    if (p.meta?.file) metaParts.push(`file=${p.meta.file}`);

    lines.push(`${chalk.bold(`#${p.id}`)}  ${chalk.gray(ago)}`);
    if (metaParts.length > 0) {
      lines.push(`  ${chalk.gray(metaParts.join(" · "))}`);
    }

    const contentLines = p.content.split("\n").slice(0, 3);
    for (const cl of contentLines) {
      lines.push(`  ${chalk.gray("│")} ${cl}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
