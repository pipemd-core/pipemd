import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { CrewSession } from "../crew.js";
import { log } from "../logger.js";
import {
  type CrewMessage,
  type SyncMessage,
  type PeerConfig,
  type RelayStatus,
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

function hostname(): string {
  return os.hostname();
}

const MAX_BODY_BYTES = 1024 * 1024;

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

function readPeers(): PeerConfig[] {
  try {
    const homeDir = os.homedir();
    const peersFile = path.join(homeDir, ".pipemd", "link", "peers.json");
    if (!fs.existsSync(peersFile)) return [];
    return JSON.parse(fs.readFileSync(peersFile, "utf-8")) as PeerConfig[];
  } catch {
    return [];
  }
}

function readToken(): string {
  try {
    const homeDir = os.homedir();
    const tokenFile = path.join(homeDir, ".pipemd", "link", "relay.token");
    if (fs.existsSync(tokenFile)) {
      return fs.readFileSync(tokenFile, "utf-8").trim();
    }
  } catch {}
  return "";
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
    const [host, portStr] = peer.host.split(":");
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
            const now = Date.now();
            for (const [group, sessions] of Object.entries(remote.groups)) {
              let origins = store.get(group);
              if (!origins) {
                origins = new Map();
                store.set(group, origins);
              }
              origins.set(remote.hostname, { sessions, lastSeen: now });
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
  const token = readToken();
  const auth = req.headers.authorization;
  if (token && auth !== `Bearer ${token}`) {
    jsonResponse(res, 403, { error: "unauthorized" });
    return;
  }

  readBody(req)
    .then((raw) => {
      const msg = JSON.parse(raw) as SyncMessage;
      const now = Date.now();

      for (const [group, sessions] of Object.entries(msg.groups)) {
        let origins = store.get(group);
        if (!origins) {
          origins = new Map();
          store.set(group, origins);
        }
        origins.set(msg.hostname, { sessions, lastSeen: now });
      }

      const myGroups: Record<string, CrewSession[]> = {};
      for (const [group, origins] of store) {
        const sessions: CrewSession[] = [];
        for (const [origin, entry] of origins) {
          if (origin !== msg.hostname) {
            sessions.push(...entry.sessions);
          }
        }
        if (sessions.length > 0) myGroups[group] = sessions;
      }

      peerLastSync.set(msg.hostname, now);
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

function requestHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === "POST" && req.url === "/crew") {
    handleCrew(req, res);
  } else if (req.method === "POST" && req.url === "/sync") {
    handleSync(req, res);
  } else if (req.method === "GET" && req.url === "/status") {
    handleStatus(req, res);
  } else if (req.method === "GET" && req.url === "/health") {
    jsonResponse(res, 200, { ok: true, hostname: hostname() });
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

    server.listen(port, () => {
      const addr = server!.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      log.info(`Relay listening on port ${actualPort}`);

      syncTimer = setInterval(syncWithPeers, POLL_INTERVAL_MS);
      expiryTimer = setInterval(expireStaleGroups, POLL_INTERVAL_MS * 3);

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
  log.info("Relay stopped");
}

export function runRelay() {
  const homeDir = os.homedir();
  const linkDir = path.join(homeDir, ".pipemd", "link");
  fs.mkdirSync(linkDir, { recursive: true });

  const pidFile = path.join(linkDir, "relay.pid");
  fs.writeFileSync(pidFile, String(process.pid), "utf-8");

  process.on("SIGTERM", () => {
    try { fs.unlinkSync(pidFile); } catch {}
    stopRelay();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    try { fs.unlinkSync(pidFile); } catch {}
    stopRelay();
    process.exit(0);
  });

  const envPort = parseInt(process.env.PMD_LINK_PORT || "", 10);
  let port = isNaN(envPort) ? DEFAULT_PORT : envPort;

  startRelay(port).then((actualPort) => {
    log.info(`Relay running on port ${actualPort}`);
    const portFile = path.join(linkDir, "relay.port");
    fs.writeFileSync(portFile, String(actualPort), "utf-8");
  }).catch((err) => {
    log.error(`Relay failed to start: ${err.message}`);
    try { fs.unlinkSync(pidFile); } catch {}
    process.exit(1);
  });
}
