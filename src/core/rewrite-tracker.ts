import { log, errMsg } from "./logger.js";

/**
 * V15 — Adaptive injection rewrite tracker.
 *
 * Per-session, per-file edit counter. The first edit to a file in a session
 * is its "creation"; every subsequent edit is a "rewrite" (V14's durable
 * learnable signal — `rw_*` features, +0.0123 on content-fit Ridge R²). The
 * adaptive delivery mode uses `editCount` to BOOST injections for files the
 * agent is iterating on.
 *
 * SESSION-SCOPED (CDC R-22): the key is always `(sessionId, filePath)`. There
 * is no global state, no path by which one session's edits can leak into
 * another's rate — verified by `tests/test-rewrite-tracker.ts`.
 *
 * Lifecycle: `recordEdit` is called from `resolveInjections` whenever the
 * trigger is `before-edit` or `after-edit` (the daemon's hook surface for the
 * agent's edit tool). `clearSession` is called on session-end (daemon
 * teardown). A periodic LRU sweep guards against unbounded growth if the
 * daemon outlives many sessions (cap = MAX_TRACKED_SESSIONS).
 */

const MAX_TRACKED_SESSIONS = 64;

/** sessionId → filePath → editCount */
const sessions: Map<string, Map<string, number>> = new Map();

function touchSession(sessionId: string): Map<string, number> {
  let files = sessions.get(sessionId);
  if (!files) {
    files = new Map();
    sessions.set(sessionId, files);
    if (sessions.size > MAX_TRACKED_SESSIONS) {
      sweep();
    }
  }
  return files;
}

/** Drop the oldest sessions until we're under the cap. Deterministic by insertion order. */
function sweep(): void {
  let toDrop = sessions.size - MAX_TRACKED_SESSIONS;
  if (toDrop <= 0) return;
  for (const key of sessions.keys()) {
    if (toDrop <= 0) break;
    sessions.delete(key);
    toDrop--;
  }
}

/**
 * Record an edit to `filePath` within `sessionId`. The first edit sets the
 * count to 1 (file creation/first-touch); subsequent edits increment.
 * Calling with an empty `sessionId` or `filePath` is a no-op (defensive —
 * the daemon occasionally resolves with a synthetic id before the agent
 * advertises one).
 */
export function recordEdit(sessionId: string, filePath: string): void {
  if (!sessionId || !filePath) return;
  try {
    const files = touchSession(sessionId);
    files.set(filePath, (files.get(filePath) ?? 0) + 1);
  } catch (err: unknown) {
    log.debug(`rewrite-tracker.recordEdit failed: ${errMsg(err)}`);
  }
}

/** Number of times `filePath` has been edited in `sessionId` (0 if never). */
export function editCount(sessionId: string, filePath: string): number {
  if (!sessionId || !filePath) return 0;
  return sessions.get(sessionId)?.get(filePath) ?? 0;
}

/**
 * Per-file rewrite rate ∈ [0, 1].
 *
 * Defined (matching V14 `rw_rw_ratio`) as `(edits - 1) / edits` for files
 * touched at least once. The first edit is the creation; every later edit
 * is a rewrite, so 2 edits → rate 0.5, 3 edits → 0.67, etc. Returns 0 for
 * untouched files.
 */
export function rewriteRate(sessionId: string, filePath: string): number {
  const n = editCount(sessionId, filePath);
  if (n <= 1) return 0;
  return (n - 1) / n;
}

/**
 * Session-wide rewrite rate ∈ [0, 1] = Σ rewrites / Σ edits across every
 * file touched in the session. Returns 0 for an empty session.
 */
export function sessionRewriteRate(sessionId: string): number {
  const files = sessions.get(sessionId);
  if (!files || files.size === 0) return 0;
  let edits = 0;
  let rewrites = 0;
  for (const count of files.values()) {
    edits += count;
    if (count > 1) rewrites += count - 1;
  }
  if (edits === 0) return 0;
  return rewrites / edits;
}

/** Forget every file tracked for `sessionId`. Used by daemon teardown and tests. */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Test/debug helper: total files tracked for a session. */
export function trackedFileCount(sessionId: string): number {
  return sessions.get(sessionId)?.size ?? 0;
}

/** Reset all sessions. Tests only — never call from production paths. */
export function resetAll(): void {
  sessions.clear();
}
