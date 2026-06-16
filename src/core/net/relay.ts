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
  DEFAULT_PORT,
  POLL_INTERVAL_MS,
  SESSION_EXPIRY_MS,
} from "./protocol.js";

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
    const homeDir = os.homedir();
    const peersFile = path.join(homeDir, ".pipemd", "link", "peers.json");
    if (!fs.existsSync(peersFile)) return [];
    return JSON.parse(fs.readFileSync(peersFile, "utf-8")) as PeerConfig[];
  } catch (err: unknown) { log.debug(`readPeers failed: ${errMsg(err)}`); return []; }
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
    const homeDir = os.homedir();
    const tokenFile = path.join(homeDir, ".pipemd", "link", "relay.token");
    if (fs.existsSync(tokenFile)) {
      const token = fs.readFileSync(tokenFile, "utf-8").trim();
      enforceFilePermissions(tokenFile);
      return token;
    }
  } catch (err: unknown) { log.debug(`read relay token failed: ${errMsg(err)}`); }
  return "";
}

let cachedRelayToken: string | null = null;

function enforceToken(): string {
  if (cachedRelayToken) return cachedRelayToken;
  const token = readToken();
  if (!token) {
    throw new Error("Relay token not found — refusing to start without authentication. Delete .pipemd/link/ and run `pmd link` to regenerate.");
  }
  cachedRelayToken = token;
  return token;
}

function syncWithPeers() {
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
    const lastColon = peer.host.lastIndexOf(":");
    const host = peer.host.slice(0, lastColon);
    const portStr = peer.host.slice(lastColon + 1);
    const port = parseInt(portStr || "9741", 10);
    const payload: SyncMessage = { hostname: myHostname, groups: allGroups };

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
  const token = cachedRelayToken || readToken();
  const auth = req.headers.authorization;
  if (!token || !auth || !timingSafeEqual(auth, `Bearer ${token}`)) {
    jsonResponse(res, 403, { error: "unauthorized" });
    return;
  }

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
  });
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

function requestHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === "POST" && req.url === "/crew") {
    handleCrew(req, res);
  } else if (req.method === "POST" && req.url === "/sync") {
    handleSync(req, res);
  } else if (req.method === "POST" && req.url === "/blocks") {
    handleBlocksPush(req, res);
  } else if (req.method === "GET" && req.url?.startsWith("/blocks")) {
    handleBlocksFetch(req, res);
  } else if (req.method === "GET" && req.url === "/status") {
    handleStatus(req, res);
  } else if (req.method === "GET" && req.url === "/health") {
    handleHealth(req, res);
  } else if (req.method === "GET" && req.url === "/metrics") {
    handleMetrics(req, res);
  } else {
    jsonResponse(res, 404, { error: "not found" });
  }
}

export function startRelay(port: number = DEFAULT_PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(requestHandler);

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        server = null;
        reject(err);
      } else {
        log.error(`Relay error: ${err.message}`);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      const addr = server!.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      log.info(`Relay listening on port ${actualPort}`);

      syncTimer = setInterval(syncWithPeers, POLL_INTERVAL_MS);
      expiryTimer = setInterval(() => { expireStaleGroups(); expireBlockStore(); }, POLL_INTERVAL_MS * 3);

      relayStartTime = Date.now();
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
