import { execFileSync } from "node:child_process";
import { log } from "./logger.js";
import { snapshotProcesses, resolvePassiveAgents } from "./crew-process.js";
import type { ProcInfo } from "./crew-process.js";
import {
  listSessions,
  findConflicts,
  reapStaleSessions,
  type CrewSession,
  type CrewConflict,
} from "./crew.js";

// NOTE: This module imports from crew.ts, and crew.ts re-exports from this module.
// This is safe because all imports here are used inside functions (lazy evaluation),
// never at module-initialization time.

export interface CrewStatusJson {
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
}

function resolveUncommittedFiles(): string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean).map((l) => l.slice(3));
  } catch (err: unknown) {
    log.debug(`resolveUncommittedFiles failed: ${err instanceof Error ? err.message : String(err)}`);
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
  } catch (err: unknown) { log.debug(`getStatusJson snapshotProcesses failed: ${err instanceof Error ? err.message : String(err)}`); }

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
