/**
 * ============================================================================
 * RELAY AUDIT — feat/hermes-network, Track B.1 (Unfreeze Relay)
 * Audited against the 464-line frozen baseline. Findings below are the basis
 * for the unfreeze work and are intentionally retained as living docs.
 * ============================================================================
 *
 * WHAT WORKS
 * ----------
 *  - Core HTTP server lifecycle: startRelay/stopRelay/runRelay boot, bind, and
 *    tear down cleanly on SIGTERM/SIGINT (writes relay.pid / relay.port).
 *  - Token auth on /sync uses crypto.timingSafeEqual — constant-time, good.
 *  - /crew merge logic (mergeSessionsFor) correctly excludes the caller's own
 *    origin and tags remote sessions with _remote/_origin.
 *  - /sync handshake avoids echo: responder replies with groups from origins
 *    OTHER than the requester (msg.hostname).
 *  - Block store has TTL (30min) + max (1000) eviction in expireBlockStore().
 *  - Body size guard (MAX_BODY_BYTES 1MiB) prevents unbounded memory growth.
 *  - readBody / jsonResponse helpers are clean and reused everywhere.
 *  - localhost-only enforcement on /crew and /blocks (isLocalhost) is correct.
 *
 * WHAT IS BROKEN (or latent bugs)
 * --------------------------------
 *  B1. startRelay() can only be called once per process safely. `server` is a
 *      module singleton; a second startRelay() without stopRelay() overwrites
 *      the reference and ORPHANS the listening server (un-stoppable, port leak)
 *      and does not clear `store`/`blockStore`/`cachedRelayToken`. Critical for
 *      tests and daemon restarts.
 *  B2. stopRelay() clears blockStore but NOT the crew `store` map nor
 *      peerLastSync nor cachedRelayToken. Result: restarts carry STALE crew
 *      sessions and a stale token; inconsistent with blockStore.clear().
 *  B3. startRelay()'s server "error" handler only rejects on EADDRINUSE. Any
 *      OTHER listen error (e.g. EACCES) is logged but the Promise NEVER settles
 *      — callers hang forever. Should reject on all errors pre-listen.
 *  B4. Relay binds to "127.0.0.1" ONLY (startRelay listen call). The target
 *      Empire topology needs exoserver <-> workstation reachability; peers
 *      cannot POST /sync to a localhost-bound relay. This is the #1 blocker for
 *      real cross-machine operation (intentional while frozen, must change).
 *  B5. /status is fully unauthenticated AND returns peer hostnames + group
 *      names + sync times. Safe only because of the localhost bind (B4); the
 *      moment the bind opens up, this leaks topology. Needs an auth gate or
 *      localhost check before B4 is resolved.
 *  B6. peer host parsing in syncWithPeers uses lastIndexOf(":") to split
 *      host:port — breaks for IPv6 literals (e.g. [::1]:9741).
 *
 * WHAT IS INCOMPLETE (per plan B.1-B.4)
 * -------------------------------------
 *  I1. /health is a stub: returns only { ok, hostname }. Plan B.1 requires
 *      daemon status + hostname + uptime + peer count. (Addressed below.)
 *  I2. No /metrics endpoint. Plan B.1 requires block count, crew session count,
 *      and sync latency. (Addressed below.)
 *  I3. No uptime tracking (no start timestamp recorded) — needed by /health.
 *  I4. No sync-latency telemetry — needed by /metrics.
 *  I5. Peer discovery is readPeers() from ~/.pipemd/link/peers.json (JSON),
 *      but plan B.4 specifies ~/.pipemd/peers.yml. Format/path mismatch to
 *      reconcile when wiring peer-discovery.ts.
 *  I6. No block origin-hostname tagging / cross-machine dedup (plan B.2).
 *  I7. No crew broadcast / claim propagation across machines (plan B.3).
 *  I8. SESSION_EXPIRY_MS = 15s is aggressive vs POLL_INTERVAL_MS = 5s; plan
 *      calls for TTL tuning once multi-machine latency is measured.
 *
 * END AUDIT
 * ============================================================================
 */
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { CrewSession } from "../crew.js";
import { log, errMsg } from "../logger.js";
import {
  type CrewMessage,
  type SyncMessage,
  type PeerConfig,
  type RelayStatus,
  type BlockPushMessage,
  type BlockEntry,
  type WorkspaceContextResponse,
  DEFAULT_PORT,
  POLL_INTERVAL_MS,
  SESSION_EXPIRY_MS,
} from "./protocol.js";
import { fleetRuntime } from "./fleet-runtime.js";
import type { FleetResponse } from "./fleet-schema.js";

type OriginMap = Map<string, { sessions: CrewSession[]; lastSeen: number }>;
const store = new Map<string, OriginMap>();
const peerLastSync = new Map<string, number>();
let syncTimer: ReturnType<typeof setInterval> | null = null;
let expiryTimer: ReturnType<typeof setInterval> | null = null;
let server: http.Server | null = null;
let relayStartTime: number | null = null;
let lastSyncLatencyMs: number | null = null;

type BlockKey = `${string}:${string}:${string}`;
const blockStore = new Map<BlockKey, BlockEntry>();
const BLOCK_STORE_TTL_MS = 30 * 60 * 1000;
const BLOCK_STORE_MAX = 1000;

function hostname(): string {
  return os.hostname();
}

function sanitizeHostname(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 253);
  return cleaned || "unknown";
}

const MAX_BODY_BYTES = 1024 * 1024;

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isLocalhost(req: http.IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (c: Buffer) => {
      received += c.length;
      if (received > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(res: http.ServerResponse, code: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function mergeSessionsFor(group: string, excludeOrigin: string): CrewSession[] {
  const origins = store.get(group);
  if (!origins) return [];
  const out: CrewSession[] = [];
  for (const [origin, entry] of origins) {
    if (origin === excludeOrigin) continue;
    out.push(
      ...entry.sessions.map((s) => ({
        ...s,
        _remote: true as const,
        _origin: origin,
      })),
    );
  }
  return out;
}

function expireStaleGroups() {
  const now = Date.now();
  for (const [group, origins] of store) {
    for (const [origin, entry] of origins) {
      if (now - entry.lastSeen > SESSION_EXPIRY_MS) {
        origins.delete(origin);
        log.info(`Relay: expired ${origin}/${group} (stale ${Math.round((now - entry.lastSeen) / 1000)}s)`);
      }
    }
    if (origins.size === 0) {
      store.delete(group);
    }
  }
}

function expireBlockStore() {
  const now = Date.now();
  for (const [key, entry] of blockStore) {
    if (now - entry.timestamp > BLOCK_STORE_TTL_MS) {
      blockStore.delete(key);
    }
  }
  if (blockStore.size > BLOCK_STORE_MAX) {
    const entries = [...blockStore.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const excess = blockStore.size - BLOCK_STORE_MAX;
    for (let i = 0; i < excess; i++) {
      blockStore.delete(entries[i][0]);
    }
  }
}

function readPeers(): PeerConfig[] {
  try {
    const peersFile = path.join(os.homedir(), ".pipemd", "link", "peers.json");
    if (!fs.existsSync(peersFile)) return [];
    const raw = JSON.parse(fs.readFileSync(peersFile, "utf-8"));
    if (!Array.isArray(raw)) return [];
    const peers: PeerConfig[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      if (typeof entry.host !== "string" || entry.host.length === 0) continue;
      if (typeof entry.token !== "string" || entry.token.length === 0) continue;
      peers.push({
        host: entry.host,
        port: typeof entry.port === "number" ? entry.port : undefined,
        token: entry.token,
        label: typeof entry.label === "string" ? entry.label : undefined,
      });
    }
    return peers;
  } catch (err: unknown) { log.debug(`readPeers failed: ${errMsg(err)}`); return []; }
}

/**
 * Resolve a `:machine` path segment to a proxy target.
 *  - "self", "_local", or the local os.hostname() → local opencode hop
 *  - otherwise match a peer by label, then by host
 * Returns null when the machine is unknown (caller → 404/502).
 */
type ProxyTarget =
  | { kind: "self" }
  | { kind: "peer"; host: string; port: number; token: string };

function resolveTarget(machine: string): ProxyTarget | null {
  if (machine === "self" || machine === "_local" || machine === hostname()) {
    return { kind: "self" };
  }
  const peers = readPeers();
  const byLabel = peers.find((p) => p.label && p.label === machine);
  const peer = byLabel ?? peers.find((p) => p.host === machine);
  if (!peer) return null;
  return { kind: "peer", host: peer.host, port: peer.port ?? DEFAULT_PORT, token: peer.token };
}

/** Base URL of the co-located opencode server (Option A: 127.0.0.1:4096). */
function opencodeBaseUrl(): string {
  return (process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096").replace(/\/$/, "");
}

/**
 * Basic-auth header for the local opencode hop. User `opencode`,
 * password OPENCODE_SERVER_PASSWORD. Hermes never sees this header — the
 * relay injects it only on the localhost downstream leg.
 */
function opencodeBasicAuth(): string {
  const user = process.env.OPENCODE_SERVER_USER || "opencode";
  const pass = process.env.OPENCODE_SERVER_PASSWORD || "";
  return "Basic " + Buffer.from(`${user}:${pass}`, "utf-8").toString("base64");
}

function enforceFilePermissions(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err: unknown) {
    log.debug(`chmod ${filePath} failed: ${errMsg(err)}`);
  }
}

function readToken(): string {
  try {
    const tokenFile = path.join(os.homedir(), ".pipemd", "link", "relay.token");
    if (fs.existsSync(tokenFile)) {
      return fs.readFileSync(tokenFile, "utf-8").trim();
    }
  } catch (err: unknown) { log.debug(`read relay token failed: ${errMsg(err)}`); }
  return "";
}

function enforceToken(): string {
  const token = readToken();
  if (!token) {
    throw new Error("Relay token not found — refusing to start without authentication. Delete .pipemd/link/ and run `pmd link` to regenerate.");
  }
  enforceFilePermissions(path.join(os.homedir(), ".pipemd", "link", "relay.token"));
  return token;
}

function authMiddleware(req: http.IncomingMessage): boolean {
  const token = readToken();
  if (!token) return false;
  const auth = req.headers.authorization;
  if (!auth) return false;
  return timingSafeEqual(auth, `Bearer ${token}`);
}

export function syncWithPeers() {
  expireStaleGroups();

  const peers = readPeers();
  if (peers.length === 0) return;

  const localToken = readToken();
  const allGroups: Record<string, CrewSession[]> = {};
  for (const [group, origins] of store) {
    const sessions: CrewSession[] = [];
    for (const [, entry] of origins) {
      sessions.push(...entry.sessions);
    }
    allGroups[group] = sessions;
  }

  const myHostname = hostname();

  for (const peer of peers) {
    const host = peer.host;
    const port = peer.port ?? DEFAULT_PORT;
    // B2-3: include the fleet snapshot so peers can render our topology.
    const payload: SyncMessage = { hostname: myHostname, groups: allGroups, fleet: fleetRuntime.buildSyncPayload() };

    const body = JSON.stringify(payload);
    const req = http.request(
      { hostname: host, port, path: "/sync", method: "POST", timeout: 5000, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${localToken || peer.token}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return;
          try {
            const remote = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as SyncMessage;
            const remoteHost = sanitizeHostname(remote.hostname);
            const now = Date.now();
            for (const [group, sessions] of Object.entries(remote.groups)) {
              let origins = store.get(group);
              if (!origins) {
                origins = new Map();
                store.set(group, origins);
              }
              origins.set(remoteHost, { sessions, lastSeen: now });
            }
            peerLastSync.set(peer.host, now);
          } catch {
            log.warn(`Relay: failed to parse sync response from ${peer.host}`);
          }
        });
      },
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.write(body);
    req.end();
  }
}

function handleCrew(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!isLocalhost(req)) {
    jsonResponse(res, 403, { error: "forbidden: /crew is localhost-only" });
    return;
  }

  readBody(req)
    .then((raw) => {
      const msg = JSON.parse(raw) as CrewMessage;
      const { group, hostname: origin, sessions } = msg;

      let origins = store.get(group);
      if (!origins) {
        origins = new Map();
        store.set(group, origins);
      }
      origins.set(origin, { sessions, lastSeen: Date.now() });
      log.info(`Relay: received ${sessions.length} session(s) for ${group} from ${origin}`);

      const remoteSessions = mergeSessionsFor(group, origin);
      jsonResponse(res, 200, { sessions: remoteSessions });
    })
    .catch(() => jsonResponse(res, 400, { error: "invalid body" }));
}

function handleSync(req: http.IncomingMessage, res: http.ServerResponse) {
  const t0 = Date.now();

  readBody(req)
    .then((raw) => {
      const msg = JSON.parse(raw) as SyncMessage;
      const safeHostname = sanitizeHostname(msg.hostname);
      const requesterGroups = new Set(Object.keys(msg.groups));
      const now = Date.now();

      for (const [group, sessions] of Object.entries(msg.groups)) {
        let origins = store.get(group);
        if (!origins) {
          origins = new Map();
          store.set(group, origins);
        }
        origins.set(safeHostname, { sessions, lastSeen: now });
      }

      const myGroups: Record<string, CrewSession[]> = {};
      for (const [group, origins] of store) {
        if (!requesterGroups.has(group)) continue;
        const sessions: CrewSession[] = [];
        for (const [origin, entry] of origins) {
          if (origin !== safeHostname) {
            sessions.push(...entry.sessions);
          }
        }
        if (sessions.length > 0) myGroups[group] = sessions;
      }

      peerLastSync.set(safeHostname, now);
      // B2-3: merge any federated fleet payload from the peer.
      if (msg.fleet) {
        fleetRuntime.importPeer(msg.fleet);
      }
      lastSyncLatencyMs = Date.now() - t0;
      jsonResponse(res, 200, { hostname: hostname(), groups: myGroups });
    })
    .catch(() => jsonResponse(res, 400, { error: "invalid body" }));
}

function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse) {
  const groups: RelayStatus["groups"] = {};
  const myHost = hostname();
  for (const [group, origins] of store) {
    let local = 0;
    let remote = 0;
    for (const [origin, entry] of origins) {
      if (origin === myHost) local += entry.sessions.length;
      else remote += entry.sessions.length;
    }
    groups[group] = { local, remote };
  }

  const peers = readPeers().map((p) => {
    const ts = peerLastSync.get(p.host);
    return { host: p.host, lastSync: ts ? new Date(ts).toISOString() : null };
  });

  jsonResponse(res, 200, { ok: true, hostname: myHost, groups, peers });
}

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse) {
  const uptimeSeconds =
    relayStartTime != null
      ? Math.max(0, Math.round((Date.now() - relayStartTime) / 1000))
      : 0;
  jsonResponse(res, 200, {
    ok: true,
    daemon: "running",
    hostname: hostname(),
    uptime: uptimeSeconds,
    peers: readPeers().length,
    pid: process.pid,
  });
}

function handleMetrics(_req: http.IncomingMessage, res: http.ServerResponse) {
  let crewSessions = 0;
  for (const origins of store.values()) {
    for (const entry of origins.values()) {
      crewSessions += entry.sessions.length;
    }
  }
  jsonResponse(res, 200, {
    hostname: hostname(),
    blocks: blockStore.size,
    crewSessions,
    syncLatencyMs: lastSyncLatencyMs,
    peerFleet: fleetRuntime.peerCount(),
  });
}

/**
 * GET /fleet (B2-2) — the federated read view. Bearer-authed.
 * Returns the frozen FleetResponse (see fleet-schema.ts): self row first
 * (from the local opencode subscriber), then peer rows (from B2-3 federation).
 */
function handleFleet(_req: http.IncomingMessage, res: http.ServerResponse) {
  const body: FleetResponse = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    relay: hostname(),
    machines: fleetRuntime.snapshot(),
  };
  jsonResponse(res, 200, body);
}

/**
 * POST /fleet/:machine/session/:id/message (B2-4) — dispatch proxy.
 * Bearer-authed at the relay edge; the relay injects Basic auth on the
 * localhost hop to opencode. For remote machines, forwards to that machine's
 * peer relay (which performs its own local hop). Hermes never sees opencode
 * creds. opencode never sees the Bearer token.
 */
function handleDispatch(req: http.IncomingMessage, res: http.ServerResponse, machine: string, sessionId: string) {
  readBody(req)
    .then((raw) => {
      const target = resolveTarget(machine);
      if (!target) {
        jsonResponse(res, 404, { error: `unknown machine: ${machine}` });
        return;
      }
      if (target.kind === "self") {
        // Local hop to opencode with injected Basic auth.
        const downstream = forwardToOpencode(
          `/api/session/${encodeURIComponent(sessionId)}/message`,
          "POST",
          raw,
          req.headers["content-type"] || "application/json",
        );
        downstream.then((r) => pipeRaw(res, r.status, r.body, r.contentType)).catch((err) => {
          log.warn(`dispatch: opencode hop failed: ${errMsg(err)}`);
          jsonResponse(res, 502, { error: "opencode unreachable" });
        });
      } else {
        // Peer-relay hop. Forward to POST /fleet/self/session/:id/message so the
        // peer relay performs its own local-hop with its own Basic auth.
        const path = `/fleet/self/session/${encodeURIComponent(sessionId)}/message`;
        forwardToPeer(target, path, "POST", raw, req.headers["content-type"] || "application/json")
          .then((r) => pipeRaw(res, r.status, r.body, r.contentType))
          .catch((err) => {
            log.warn(`dispatch: peer hop failed: ${errMsg(err)}`);
            jsonResponse(res, 502, { error: "peer relay unreachable" });
          });
      }
    })
    .catch(() => jsonResponse(res, 400, { error: "invalid body" }));
}

/**
 * Forward a request to the co-located opencode server with injected Basic
 * auth. Used by the dispatch proxy (B2-4) and the PTY takeover proxy (B2-5).
 */
function forwardToOpencode(
  opencodePath: string,
  method: string,
  body: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(opencodePath, opencodeBaseUrl());
    } catch (err: unknown) {
      reject(err);
      return;
    }
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      Authorization: opencodeBasicAuth(),
      ...extraHeaders,
    };
    if (body.length > 0) headers["Content-Length"] = String(Buffer.byteLength(body));
    const downstream = http.request(
      {
        hostname: url.hostname,
        port: url.port || 4096,
        path: url.pathname + url.search,
        method,
        timeout: 10_000,
        headers,
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => resolve({
          status: r.statusCode || 502,
          body: Buffer.concat(chunks).toString("utf-8"),
          contentType: r.headers["content-type"] || "application/json",
        }));
      },
    );
    downstream.on("error", reject);
    downstream.on("timeout", () => { downstream.destroy(); reject(new Error("opencode timeout")); });
    if (body.length > 0) downstream.write(body);
    downstream.end();
  });
}

/**
 * Forward a request to a peer relay with the peer's Bearer token. Used to
 * chain a proxy request from this relay to the target machine's relay, which
 * then performs its own local hop.
 */
function forwardToPeer(
  target: { host: string; port: number; token: string },
  peerPath: string,
  method: string,
  body: string,
  contentType: string,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      Authorization: `Bearer ${target.token}`,
    };
    if (body.length > 0) headers["Content-Length"] = String(Buffer.byteLength(body));
    const downstream = http.request(
      {
        hostname: target.host,
        port: target.port,
        path: peerPath,
        method,
        timeout: 10_000,
        headers,
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => resolve({
          status: r.statusCode || 502,
          body: Buffer.concat(chunks).toString("utf-8"),
          contentType: r.headers["content-type"] || "application/json",
        }));
      },
    );
    downstream.on("error", reject);
    downstream.on("timeout", () => { downstream.destroy(); reject(new Error("peer relay timeout")); });
    if (body.length > 0) downstream.write(body);
    downstream.end();
  });
}

/** Write a raw (possibly non-JSON) downstream body back to the caller. */
function pipeRaw(res: http.ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function handleBlocksPush(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!isLocalhost(req)) {
    jsonResponse(res, 403, { error: "forbidden: /blocks is localhost-only" });
    return;
  }

  readBody(req)
    .then((raw) => {
      const msg = JSON.parse(raw) as BlockPushMessage;
      if (!msg.group || !msg.hostname || !msg.commitSha || !Array.isArray(msg.blocks)) {
        jsonResponse(res, 400, { error: "missing fields: group, hostname, commitSha, blocks" });
        return;
      }

      let stored = 0;
      for (const block of msg.blocks) {
        const key: BlockKey = `${msg.group}:${msg.commitSha}:${block.source}`;
        blockStore.set(key, { source: block.source, data: block.data, timestamp: block.timestamp, hash: block.hash });
        stored++;
      }
      log.info(`Relay: stored ${stored} block(s) for ${msg.group}@${msg.commitSha.substring(0, 8)} from ${msg.hostname}`);
      jsonResponse(res, 200, { ok: true, stored });
    })
    .catch(() => jsonResponse(res, 400, { error: "invalid body" }));
}

function handleBlocksFetch(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!isLocalhost(req)) {
    jsonResponse(res, 403, { error: "forbidden: /blocks is localhost-only" });
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  const group = url.searchParams.get("group");
  const commitSha = url.searchParams.get("commitSha");

  if (!group || !commitSha) {
    jsonResponse(res, 400, { error: "missing query params: group, commitSha" });
    return;
  }

  const prefix: string = `${group}:${commitSha}:`;
  const blocks: BlockEntry[] = [];
  for (const [key, entry] of blockStore) {
    if (key.startsWith(prefix)) {
      blocks.push(entry);
    }
  }

  jsonResponse(res, 200, { blocks, hostname: hostname() });
}

const WORKSPACE_SANDBOX_BASE = path.join(os.homedir(), ".pipemd", "workspaces");
const AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;

function handleWorkspaceContext(res: http.ServerResponse, agentId: string) {
  const resolved = path.resolve(WORKSPACE_SANDBOX_BASE, agentId, "context.md");
  if (!resolved.startsWith(WORKSPACE_SANDBOX_BASE + path.sep)) {
    jsonResponse(res, 400, { error: "invalid agent id" });
    return;
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      jsonResponse(res, 404, { error: "workspace context not found" });
      return;
    }
    const content = fs.readFileSync(resolved, "utf-8");
    const body: WorkspaceContextResponse = {
      last_updated: stat.mtime.toISOString(),
      content,
    };
    jsonResponse(res, 200, body);
  } catch (err: unknown) {
    log.debug(`workspace context read failed: ${errMsg(err)}`);
    jsonResponse(res, 404, { error: "workspace context not found" });
  }
}

function requestHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (req.method === "POST" && pathname === "/crew") {
    handleCrew(req, res);
  } else if (req.method === "POST" && pathname === "/sync") {
    if (!authMiddleware(req)) { jsonResponse(res, 401, { error: "unauthorized" }); return; }
    handleSync(req, res);
  } else if (req.method === "POST" && pathname === "/blocks") {
    handleBlocksPush(req, res);
  } else if (req.method === "GET" && pathname === "/blocks") {
    handleBlocksFetch(req, res);
  } else if (req.method === "POST") {
    // B2-4 dispatch proxy: /fleet/:machine/session/:id/message
    const dispatchMatch = pathname.match(/^\/fleet\/([^/]+)\/session\/([^/]+)\/message$/);
    if (dispatchMatch) {
      if (!authMiddleware(req)) { jsonResponse(res, 401, { error: "unauthorized" }); return; }
      handleDispatch(req, res, decodeURIComponent(dispatchMatch[1]), decodeURIComponent(dispatchMatch[2]));
    } else {
      jsonResponse(res, 404, { error: "not found" });
    }
  } else if (req.method === "GET" && pathname === "/status") {
    if (!authMiddleware(req)) { jsonResponse(res, 401, { error: "unauthorized" }); return; }
    handleStatus(req, res);
  } else if (req.method === "GET" && pathname === "/health") {
    if (!authMiddleware(req)) { jsonResponse(res, 401, { error: "unauthorized" }); return; }
    handleHealth(req, res);
  } else if (req.method === "GET" && pathname === "/metrics") {
    if (!authMiddleware(req)) { jsonResponse(res, 401, { error: "unauthorized" }); return; }
    handleMetrics(req, res);
  } else if (req.method === "GET" && pathname === "/fleet") {
    if (!authMiddleware(req)) { jsonResponse(res, 401, { error: "unauthorized" }); return; }
    handleFleet(req, res);
  } else if (req.method === "GET") {
    const workspaceMatch = pathname.match(/^\/workspace\/([^/]+)\/context$/);
    if (workspaceMatch) {
      const agentId = decodeURIComponent(workspaceMatch[1]);
      if (!AGENT_ID_RE.test(agentId)) {
        jsonResponse(res, 400, { error: "invalid agent id" });
        return;
      }
      if (!authMiddleware(req)) { jsonResponse(res, 401, { error: "unauthorized" }); return; }
      handleWorkspaceContext(res, agentId);
    } else {
      jsonResponse(res, 404, { error: "not found" });
    }
  } else {
    jsonResponse(res, 404, { error: "not found" });
  }
}

export function startRelay(port: number = DEFAULT_PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(requestHandler);

    server.on("error", (err: NodeJS.ErrnoException) => {
      server = null;
      reject(err);
    });

    const bind = process.env.PMD_LINK_BIND || "0.0.0.0";
    server.listen(port, bind, () => {
      const addr = server!.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      log.info(`Relay listening on port ${actualPort}`);

      syncTimer = setInterval(syncWithPeers, POLL_INTERVAL_MS);
      expiryTimer = setInterval(() => { expireStaleGroups(); expireBlockStore(); fleetRuntime.expirePeers(); }, POLL_INTERVAL_MS * 3);

      relayStartTime = Date.now();
      // B2-1: begin observing the local opencode event stream. Best-effort —
      // the subscriber reconnects with backoff if opencode isn't up yet.
      try { fleetRuntime.start(); } catch (err: unknown) { log.warn(`Relay: fleet subscriber start failed: ${errMsg(err)}`); }
      resolve(actualPort);
    });
  });
}

export function stopRelay() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
  if (server) {
    server.close();
    server = null;
  }
  relayStartTime = null;
  lastSyncLatencyMs = null;
  blockStore.clear();
  store.clear();
  peerLastSync.clear();
  // B2-1/B2-3: tear down the opencode subscriber and clear all fleet state.
  fleetRuntime.reset();
  log.info("Relay stopped");
}

export function runRelay() {
  const homeDir = os.homedir();
  const linkDir = path.join(homeDir, ".pipemd", "link");
  fs.mkdirSync(linkDir, { recursive: true });

  try {
    enforceToken();
  } catch (err: unknown) {
    const msg = errMsg(err);
    log.error(`Relay auth error: ${msg}`);
    process.exit(1);
  }

  const pidFile = path.join(linkDir, "relay.pid");
  fs.writeFileSync(pidFile, String(process.pid), "utf-8");
  enforceFilePermissions(pidFile);

  process.on("SIGTERM", () => {
    try { fs.unlinkSync(pidFile); } catch (err: unknown) { log.debug(`SIGTERM unlink pidFile failed: ${errMsg(err)}`); }
    stopRelay();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    try { fs.unlinkSync(pidFile); } catch (err: unknown) { log.debug(`SIGINT unlink pidFile failed: ${errMsg(err)}`); }
    stopRelay();
    process.exit(0);
  });

  const envPort = parseInt(process.env.PMD_LINK_PORT || "", 10);
  const port = isNaN(envPort) ? DEFAULT_PORT : envPort;

  startRelay(port).then((actualPort) => {
    log.info(`Relay running on port ${actualPort}`);
    const portFile = path.join(linkDir, "relay.port");
    fs.writeFileSync(portFile, String(actualPort), "utf-8");
    enforceFilePermissions(portFile);
  }).catch((err) => {
    log.error(`Relay failed to start: ${err.message}`);
    try { fs.unlinkSync(pidFile); } catch (err2: unknown) { log.debug(`startRelay cleanup unlink failed: ${errMsg(err2)}`); }
    process.exit(1);
  });
}
