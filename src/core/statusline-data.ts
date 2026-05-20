// statusline-data.ts — read/format helpers for the `pmd statusline` command.
//
// The OpenCode TUI panel (built as a string template in hooks.ts) embeds its own
// copy of equivalent logic — a plugin file must be self-contained, so it cannot
// import this module. This module is the canonical, testable implementation used
// by the Claude Code statusline; the two are kept behaviourally identical.

import fs from "node:fs";
import path from "node:path";
import { tryReadJson } from "./json-utils.js";
import { DEFAULT_STALE_MS } from "./crew.js";

export const STATUS_FILE = ".status.json";
export const INJECT_STATS_FILE = ".inject-stats.json";
export const CREW_STATUS_FILE = ".crew-status.json";
export const DAEMON_PID_FILE = ".daemon.pid";
export const GEMINI_STATUSLINE_STATE = ".statusline-gemini.json";

const CONTEXT_FILES = ["AGENTS.md", "AI_CONTEXT.md"];
const GEMINI_STATUSLINE_DEBOUNCE_MS = 3_000;

export interface InjectEvent {
  trigger: string;
  file: string;
  result: "delivered" | "dedup";
  ts: number;
}

export interface InjectStats {
  delivered: number;
  dedup: number;
  lastEvent?: InjectEvent;
}

/** ~4 chars per token — the same rough estimate the OpenCode TUI panel uses. */
export function estimateTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/**
 * Rendered context size in bytes. In pipe mode the context files are FIFOs
 * (statSync reports size 0), so the daemon records the real byte count in
 * .status.json — prefer that, fall back to a real on-disk file stat (legacy mode).
 */
export function findContextBytes(pipemdDir: string, cwd: string): number {
  const st = tryReadJson(path.join(pipemdDir, STATUS_FILE));
  if (st && typeof st.renderedBytes === "number" && st.renderedBytes > 0) {
    return st.renderedBytes;
  }
  for (const f of CONTEXT_FILES) {
    try {
      const s = fs.statSync(path.join(cwd, f));
      if (s.isFile() && s.size > 0) return s.size;
    } catch {
      /* not present */
    }
  }
  return 0;
}

export function readInjectStats(pipemdDir: string): InjectStats {
  const s = tryReadJson(path.join(pipemdDir, INJECT_STATS_FILE));
  return {
    delivered: typeof s?.delivered === "number" ? s.delivered : 0,
    dedup: typeof s?.dedup === "number" ? s.dedup : 0,
    lastEvent: s?.lastEvent,
  };
}

/**
 * Atomically bump the injection counters. Called from the `pmd inject` hook path
 * so the statusline has injection data — Claude Code's inject hooks call `pmd
 * inject` directly and would otherwise record nothing. Best-effort: failures are
 * swallowed so a stats hiccup never breaks an injection.
 */
export function bumpInjectStats(
  pipemdDir: string,
  result: "delivered" | "dedup",
  event: { trigger: string; file: string },
): void {
  try {
    const cur = readInjectStats(pipemdDir);
    cur[result]++;
    cur.lastEvent = {
      trigger: event.trigger,
      file: event.file,
      result,
      ts: Date.now(),
    };
    const target = path.join(pipemdDir, INJECT_STATS_FILE);
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cur), "utf-8");
    fs.renameSync(tmp, target);
  } catch {
    /* stats are best-effort — never let a write failure break injection */
  }
}

/**
 * Gemini's SessionStart hook can fire (and re-render) more than once at session
 * startup — and `AfterAgent` can land close behind it — so the `systemMessage`
 * status line paints twice. This debounce collapses that: it returns true when
 * the exact same line was already emitted within the last few seconds, and the
 * caller then emits nothing. A genuine turn-boundary repaint is seconds apart
 * and usually carries changed state, so it is never suppressed; an identical
 * one inside the window is — harmlessly, since nothing changed. Best-effort:
 * a write failure just means no debounce, never a broken hook.
 */
export function shouldSuppressGeminiStatusline(
  pipemdDir: string,
  line: string,
): boolean {
  const file = path.join(pipemdDir, GEMINI_STATUSLINE_STATE);
  const prev = tryReadJson(file);
  const now = Date.now();
  if (
    prev &&
    prev.line === line &&
    typeof prev.ts === "number" &&
    now - prev.ts < GEMINI_STATUSLINE_DEBOUNCE_MS
  ) {
    return true;
  }
  try {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ ts: now, line }), "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort — a debounce miss is fine, a thrown hook is not */
  }
  return false;
}

export interface CrewSnapshot {
  sessionCount: number;
  passiveCount: number;
  conflictPaths: string[];
}

/**
 * The daemon's unified crew snapshot (.crew-status.json — the getStatusJson()
 * output). Returns null when the file is absent or stale: a stale snapshot means
 * the daemon stopped refreshing it.
 *
 * The statusline reads sessions, conflicts and passive agents from this single
 * snapshot so the three counts are always mutually consistent — mixing it with a
 * live `listSessions()` read produced disagreeing numbers, because the daemon's
 * reaper deletes session files between snapshot writes.
 */
export function readCrewSnapshot(pipemdDir: string): CrewSnapshot | null {
  const cs = tryReadJson(path.join(pipemdDir, CREW_STATUS_FILE));
  if (!cs || typeof cs.ts !== "number") return null;
  if (Date.now() - cs.ts >= DEFAULT_STALE_MS) return null;

  const sessionCount =
    typeof cs.sessionCount === "number"
      ? cs.sessionCount
      : Array.isArray(cs.sessions)
        ? cs.sessions.length
        : 0;
  const conflictPaths = Array.isArray(cs.conflicts)
    ? cs.conflicts
        .map((c: any) => (typeof c?.path === "string" ? c.path : null))
        .filter((p: string | null): p is string => p !== null)
    : [];
  const passiveCount = Array.isArray(cs.passiveAgents)
    ? cs.passiveAgents.length
    : 0;

  return { sessionCount, passiveCount, conflictPaths };
}
