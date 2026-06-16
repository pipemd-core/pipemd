/**
 * ============================================================================
 * FLEET MODEL — in-memory reducer over OpenCode EventV2 frames (B2-1)
 * ============================================================================
 *
 * Pure, synchronous, side-effect-free. No I/O. The subscriber
 * (opencode-subscriber.ts) feeds parsed events into `applyEvent`; the relay
 * reads `snapshot()` for GET /fleet (B2-2) and federation (B2-3).
 *
 * Design rules:
 *  - State is keyed by `location.directory` (= project). workspaceID is
 *    attached when present.
 *  - `applyEvent` MUST NEVER throw — malformed frames are dropped silently
 *    (returns false). This survives opencode emitting unknown event types.
 *  - Entity lists (sessions/ptys/agents) are deduped by id; upserts merge
 *    known fields and refresh lastActivity; delete-suffix types remove.
 *  - Projects are sticky once seen — they only vanish via an explicit
 *    `project.deleted` event. A project with no live entities is still a
 *    valid working directory.
 * ============================================================================
 */

import type {
  FleetProject,
  FleetSession,
  FleetPty,
  FleetAgent,
} from "./fleet-schema.js";

/** OpenCode EventV2 frame (see packages/server/src/groups/event.ts). */
export interface EventV2 {
  id?: string;
  type?: string;
  location?: { directory?: string; workspaceID?: string; cwd?: string };
  metadata?: { timestamp?: string; [k: string]: unknown };
  data?: Record<string, unknown>;
}

/** Result of applying one event to the model. */
export type ApplyResult =
  | { ok: true; dir: string; kind: "session" | "pty" | "agent" | "project" | "ignore"; action: "upsert" | "delete" | "noop" }
  | { ok: false; reason: string };

/** Suffix patterns (matched against the part after the first `.` in `type`). */
const DELETE_SUFFIXES = /^(delete|deleted|remove|removed|end|ended|exit|exited|close|closed|disconnect|disconnected|stop|stopped|destroy|destroyed)$/i;

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function pickId(data: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!data) return undefined;
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>).id;
      if (typeof inner === "string" && inner.length > 0) return inner;
    }
  }
  return undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class FleetModel {
  private projects = new Map<string, FleetProject>();

  /** Number of distinct projects currently tracked. */
  get size(): number {
    return this.projects.size;
  }

  /** True when at least one applied event has populated the model. */
  get empty(): boolean {
    return this.projects.size === 0;
  }

  /** Reset all state. Used on subscriber restart and in tests. */
  clear(): void {
    this.projects.clear();
  }

  /**
   * Apply one parsed EventV2 frame. Never throws.
   */
  applyEvent(evt: unknown): ApplyResult {
    if (!evt || typeof evt !== "object") {
      return { ok: false, reason: "event is not an object" };
    }
    const e = evt as EventV2;

    const dir = e.location?.directory;
    if (typeof dir !== "string" || dir.length === 0) {
      return { ok: false, reason: "missing location.directory" };
    }

    const type = typeof e.type === "string" ? e.type : "";
    const lastActivity = pickString(e.metadata?.timestamp, (e.data as Record<string, unknown> | undefined)?.timestamp, e.id) || nowIso();

    // Project lifecycle.
    if (type.startsWith("project.")) {
      if (DELETE_SUFFIXES.test(type.slice("project.".length))) {
        this.projects.delete(dir);
        return { ok: true, dir, kind: "project", action: "delete" };
      }
      this.touchProject(dir, e, lastActivity);
      return { ok: true, dir, kind: "project", action: "upsert" };
    }

    const project = this.touchProject(dir, e, lastActivity);

    if (type.startsWith("session.")) {
      return this.applySession(project, type.slice("session.".length), e, lastActivity);
    }
    if (type.startsWith("pty.")) {
      return this.applyPty(project, type.slice("pty.".length), e, lastActivity);
    }
    if (type.startsWith("agent.")) {
      return this.applyAgent(project, type.slice("agent.".length), e, lastActivity);
    }

    // Unknown event type — still refresh project lastUpdated so we know it's alive.
    return { ok: true, dir, kind: "ignore", action: "noop" };
  }

  private touchProject(dir: string, e: EventV2, ts: string): FleetProject {
    let p = this.projects.get(dir);
    if (!p) {
      p = {
        dir,
        workspaceID: e.location?.workspaceID,
        sessions: [],
        ptys: [],
        agents: [],
        lastUpdated: ts,
      };
      this.projects.set(dir, p);
    } else {
      if (!p.workspaceID && e.location?.workspaceID) {
        p.workspaceID = e.location.workspaceID;
      }
      if (ts > p.lastUpdated) p.lastUpdated = ts;
    }
    return p;
  }

  private applySession(p: FleetProject, suffix: string, e: EventV2, ts: string): ApplyResult {
    const id = pickId(e.data, ["id", "sessionId", "sessionID", "session"]);
    if (!id) return { ok: false, reason: "session event without id" };

    if (DELETE_SUFFIXES.test(suffix)) {
      p.sessions = p.sessions.filter((s) => s.id !== id);
      return { ok: true, dir: p.dir, kind: "session", action: "delete" };
    }

    const data = e.data || {};
    const fields: Partial<FleetSession> = {
      agent: pickString(data.agent, data.model, data.agentId),
      title: pickString(data.title, data.name),
      lastActivity: ts,
    };

    const existing = p.sessions.find((s) => s.id === id);
    if (existing) {
      if (fields.agent) existing.agent = fields.agent;
      if (fields.title) existing.title = fields.title;
      existing.lastActivity = ts;
      return { ok: true, dir: p.dir, kind: "session", action: "upsert" };
    }
    const entry: FleetSession = { id, lastActivity: ts };
    if (fields.agent) entry.agent = fields.agent;
    if (fields.title) entry.title = fields.title;
    p.sessions.push(entry);
    return { ok: true, dir: p.dir, kind: "session", action: "upsert" };
  }

  private applyPty(p: FleetProject, suffix: string, e: EventV2, ts: string): ApplyResult {
    const id = pickId(e.data, ["id", "ptyId", "ptyID", "pty"]);
    if (!id) return { ok: false, reason: "pty event without id" };

    if (DELETE_SUFFIXES.test(suffix)) {
      p.ptys = p.ptys.filter((s) => s.id !== id);
      return { ok: true, dir: p.dir, kind: "pty", action: "delete" };
    }

    const data = e.data || {};
    const loc = e.location || {};
    const existing = p.ptys.find((s) => s.id === id);
    const cwd = pickString(data.cwd, loc.cwd, loc.directory);
    const sessionId = pickString(data.sessionId, data.sessionID, data.session);

    if (existing) {
      if (cwd) existing.cwd = cwd;
      if (sessionId) existing.sessionId = sessionId;
      existing.lastActivity = ts;
      return { ok: true, dir: p.dir, kind: "pty", action: "upsert" };
    }
    const entry: FleetPty = { id, lastActivity: ts };
    if (cwd) entry.cwd = cwd;
    if (sessionId) entry.sessionId = sessionId;
    p.ptys.push(entry);
    return { ok: true, dir: p.dir, kind: "pty", action: "upsert" };
  }

  private applyAgent(p: FleetProject, suffix: string, e: EventV2, ts: string): ApplyResult {
    const id = pickId(e.data, ["id", "agentId", "agentID", "agent"]);
    if (!id) return { ok: false, reason: "agent event without id" };

    if (DELETE_SUFFIXES.test(suffix)) {
      p.agents = p.agents.filter((s) => s.id !== id);
      return { ok: true, dir: p.dir, kind: "agent", action: "delete" };
    }

    const data = e.data || {};
    const type = pickString(data.type, data.harness, data.kind, data.role);
    const existing = p.agents.find((s) => s.id === id);

    if (existing) {
      if (type) existing.type = type;
      existing.lastActivity = ts;
      return { ok: true, dir: p.dir, kind: "agent", action: "upsert" };
    }
    const entry: FleetAgent = { id, lastActivity: ts };
    if (type) entry.type = type;
    p.agents.push(entry);
    return { ok: true, dir: p.dir, kind: "agent", action: "upsert" };
  }

  /**
   * Immutable snapshot of all projects, sorted by directory for stable output.
   * Returns shallow copies so callers can serialize without mutating state.
   */
  snapshot(): FleetProject[] {
    const dirs = [...this.projects.keys()].sort();
    return dirs.map((dir) => {
      const p = this.projects.get(dir)!;
      return {
        dir: p.dir,
        workspaceID: p.workspaceID,
        sessions: p.sessions.map((s) => ({ ...s })),
        ptys: p.ptys.map((s) => ({ ...s })),
        agents: p.agents.map((s) => ({ ...s })),
        lastUpdated: p.lastUpdated,
      };
    });
  }
}

/**
 * Parse a raw SSE chunk into discrete event frames. SSE frames are separated
 * by a blank line (`\n\n`). Within a frame, lines beginning with `data:` carry
 * the payload; multiple `data:` lines are joined with `\n`. Comments (`:`)
 * and `event:`/`id:`/`retry:` lines are ignored for our purposes — we parse
 * the `data:` payload as JSON. Malformed frames are skipped.
 *
 * Pure & synchronous — unit-testable without a server.
 */
export function parseSseChunk(chunk: string): unknown[] {
  const out: unknown[] = [];
  const frames = chunk.split(/\r?\n\r?\n/);
  for (const frame of frames) {
    if (frame.trim().length === 0) continue;
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    try {
      out.push(JSON.parse(payload));
    } catch {
      // Malformed JSON frame — ignore (REQUIREMENTS.md: "malformed events ignored").
    }
  }
  return out;
}
