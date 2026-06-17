/**
 * ============================================================================
 * FROZEN SCHEMA — GET /fleet response (Track B Phase 2, B2-2)
 * ============================================================================
 *
 * This is the wire contract every relay emits and every Hermes/CLI consumer
 * parses. It is FROZEN: field names, nesting, and types are part of the
 * public API and MUST NOT change in a backwards-incompatible way. Additive
 * changes (new optional fields) are permitted; renames, removals, or type
 * flips require a schema version bump.
 *
 * Coordinate with Track A (Hermes adapter) before touching any field name.
 *
 * Shape (REQUIREMENTS.md §B2-2):
 *   { machines: [ { host, projects: [ { dir, sessions, ptys, agents,
 *                                       lastUpdated } ] } ] }
 *
 * Versioning: `schema: 1`. Bump only on a breaking change.
 * ============================================================================
 */

export const FLEET_SCHEMA_VERSION = 1;

/** A single OpenCode session (cli/agent conversation). */
export interface FleetSession {
  id: string;
  /** Agent backend driving the session, when known (e.g. "opus-cli"). */
  agent?: string;
  /** Free-form title opencode assigns to the session, when known. */
  title?: string;
  /** ISO 8601 timestamp of the last activity observed for this session. */
  lastActivity?: string;
}

/** A live PTY allocated by opencode (interactive shell / takeover target). */
export interface FleetPty {
  id: string;
  /** Working directory the PTY was spawned in, when known. */
  cwd?: string;
  /** Owning session id, when known. */
  sessionId?: string;
  /** ISO 8601 timestamp of the last activity observed for this PTY. */
  lastActivity?: string;
}

/** A registered agent process (subset of session, for the agents[] view). */
export interface FleetAgent {
  id: string;
  /** Agent backend or harness name, when known. */
  type?: string;
  /** ISO 8601 timestamp of the last activity observed for this agent. */
  lastActivity?: string;
}

/**
 * A project = an OpenCode `location` (keyed by directory). All sessions,
 * PTYs, and agents scoped to that directory are grouped here.
 */
export interface FleetProject {
  /** Absolute path of the project working directory (location.directory). */
  dir: string;
  /** OpenCode workspaceID when available (location.workspaceID). */
  workspaceID?: string;
  sessions: FleetSession[];
  ptys: FleetPty[];
  agents: FleetAgent[];
  /** ISO 8601 timestamp; most recent event observed for this project. */
  lastUpdated: string;
}

/** One machine in the federated topology. */
export interface FleetMachine {
  /** Hostname (or label) identifying the machine. */
  host: string;
  /** True for the machine this relay is co-located with (the "self" row). */
  self?: boolean;
  projects: FleetProject[];
  /** ISO 8601 timestamp; most recent event/federation update for this machine. */
  lastUpdated: string;
}

/** Top-level /fleet response body. FROZEN. */
export interface FleetResponse {
  /** Schema version — bump only on a breaking change. Currently 1. */
  schema: typeof FLEET_SCHEMA_VERSION;
  /** ISO 8601 timestamp the relay generated this snapshot. */
  generatedAt: string;
  /** Hostname of the relay producing this response. */
  relay: string;
  machines: FleetMachine[];
}

/**
 * Peer-federation payload carried inside the existing /sync envelope.
 * Reuses FleetMachine verbatim so self + peer rows share one shape.
 * (B2-3 — promote S8 to core.)
 */
export interface FleetSyncPayload {
  /** Origin hostname of the relay that produced these machine rows. */
  origin: string;
  /** Machine rows from the origin relay (typically just the origin's self row). */
  machines: FleetMachine[];
}

/**
 * JSON Schema (draft-07) document for FleetResponse. Published alongside the
 * TS types so external consumers (Hermes, future dashboards) can validate
 * responses without depending on our TS. This object is itself frozen — it is
 * the machine-readable mirror of the interfaces above.
 */
export const FLEET_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://pipemd.dev/schemas/fleet-v1.json",
  title: "FleetResponse",
  type: "object",
  required: ["schema", "generatedAt", "relay", "machines"],
  additionalProperties: true,
  properties: {
    schema: { type: "integer", const: FLEET_SCHEMA_VERSION },
    generatedAt: { type: "string", format: "date-time" },
    relay: { type: "string", minLength: 1 },
    machines: {
      type: "array",
      items: {
        type: "object",
        required: ["host", "projects", "lastUpdated"],
        additionalProperties: true,
        properties: {
          host: { type: "string", minLength: 1 },
          self: { type: "boolean" },
          lastUpdated: { type: "string", format: "date-time" },
          projects: {
            type: "array",
            items: {
              type: "object",
              required: ["dir", "sessions", "ptys", "agents", "lastUpdated"],
              additionalProperties: true,
              properties: {
                dir: { type: "string", minLength: 1 },
                workspaceID: { type: "string" },
                sessions: { type: "array", items: { $ref: "#/$defs/session" } },
                ptys: { type: "array", items: { $ref: "#/$defs/pty" } },
                agents: { type: "array", items: { $ref: "#/$defs/agent" } },
                lastUpdated: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
    },
  },
  $defs: {
    session: {
      type: "object",
      required: ["id"],
      additionalProperties: true,
      properties: {
        id: { type: "string", minLength: 1 },
        agent: { type: "string" },
        title: { type: "string" },
        lastActivity: { type: "string", format: "date-time" },
      },
    },
    pty: {
      type: "object",
      required: ["id"],
      additionalProperties: true,
      properties: {
        id: { type: "string", minLength: 1 },
        cwd: { type: "string" },
        sessionId: { type: "string" },
        lastActivity: { type: "string", format: "date-time" },
      },
    },
    agent: {
      type: "object",
      required: ["id"],
      additionalProperties: true,
      properties: {
        id: { type: "string", minLength: 1 },
        type: { type: "string" },
        lastActivity: { type: "string", format: "date-time" },
      },
    },
  },
} as const;

/**
 * Best-effort structural validator. Returns an array of human-readable
 * violations (empty array = valid). Does NOT pull in a JSON-Schema runtime;
 * the frozen contract is small enough to check by hand, which keeps the
 * relay dependency-free.
 */
export function validateFleetResponse(body: unknown): string[] {
  const errors: string[] = [];
  if (!body || typeof body !== "object") {
    errors.push("body must be an object");
    return errors;
  }
  const o = body as Record<string, unknown>;
  if (o.schema !== FLEET_SCHEMA_VERSION) {
    errors.push(`schema must equal ${FLEET_SCHEMA_VERSION} (got ${String(o.schema)})`);
  }
  if (typeof o.generatedAt !== "string" || o.generatedAt.length === 0) {
    errors.push("generatedAt must be a non-empty string");
  }
  if (typeof o.relay !== "string" || o.relay.length === 0) {
    errors.push("relay must be a non-empty string");
  }
  if (!Array.isArray(o.machines)) {
    errors.push("machines must be an array");
    return errors;
  }
  o.machines.forEach((m, i) => {
    const prefix = `machines[${i}]`;
    if (!m || typeof m !== "object") {
      errors.push(`${prefix} must be an object`);
      return;
    }
    const mo = m as Record<string, unknown>;
    if (typeof mo.host !== "string" || mo.host.length === 0) {
      errors.push(`${prefix}.host must be a non-empty string`);
    }
    if (mo.self !== undefined && typeof mo.self !== "boolean") {
      errors.push(`${prefix}.self must be boolean when present`);
    }
    if (typeof mo.lastUpdated !== "string" || mo.lastUpdated.length === 0) {
      errors.push(`${prefix}.lastUpdated must be a non-empty string`);
    }
    if (!Array.isArray(mo.projects)) {
      errors.push(`${prefix}.projects must be an array`);
      return;
    }
    mo.projects.forEach((p, j) => {
      const pp = `${prefix}.projects[${j}]`;
      if (!p || typeof p !== "object") {
        errors.push(`${pp} must be an object`);
        return;
      }
      const po = p as Record<string, unknown>;
      if (typeof po.dir !== "string" || po.dir.length === 0) {
        errors.push(`${pp}.dir must be a non-empty string`);
      }
      for (const field of ["sessions", "ptys", "agents"] as const) {
        const arr = po[field];
        if (!Array.isArray(arr)) {
          errors.push(`${pp}.${field} must be an array`);
          continue;
        }
        arr.forEach((entry, k) => {
          const ep = `${pp}.${field}[${k}]`;
          if (!entry || typeof entry !== "object") {
            errors.push(`${ep} must be an object`);
            return;
          }
          if (typeof (entry as Record<string, unknown>).id !== "string" || ((entry as Record<string, unknown>).id as string).length === 0) {
            errors.push(`${ep}.id must be a non-empty string`);
          }
        });
      }
      if (typeof po.lastUpdated !== "string" || po.lastUpdated.length === 0) {
        errors.push(`${pp}.lastUpdated must be a non-empty string`);
      }
    });
  });
  return errors;
}
