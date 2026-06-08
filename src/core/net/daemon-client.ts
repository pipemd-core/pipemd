import http from "node:http";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CrewSession } from "../crew.js";
import { setRemoteSessions as setCrewRemoteSessions } from "../crew.js";
import { readCache, DEFAULT_TTLS } from "../cache.js";
import { BLOCK_SOURCES, isSharedBlock } from "../block-scope.js";
import { log } from "../logger.js";
import { type CrewMessage, type BlockPushMessage, type BlockEntry, POLL_INTERVAL_MS } from "./protocol.js";

const execFileAsync = promisify(execFile);

export interface RemoteSession extends CrewSession {
  _remote: true;
  _origin: string;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

function relayUrl(): string | null {
  return process.env.PMD_RELAY || null;
}

function postToRelay(
  url: URL,
  body: unknown,
): Promise<{ sessions: RemoteSession[] }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 9741,
        path: url.pathname || "/crew",
        method: "POST",
        timeout: 5000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`relay responded ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            const sessions = ((parsed.sessions || []) as RemoteSession[]).map((s) => ({
              ...s,
              _remote: true as const,
              _origin: s._origin || "remote",
            }));
            resolve({ sessions });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("relay timeout"));
    });
    req.write(data);
    req.end();
  });
}

export async function syncWithRelay(
  group: string,
  sessions: CrewSession[],
): Promise<RemoteSession[]> {
  const urlStr = relayUrl();
  if (!urlStr) return [];

  try {
    const url = new URL(urlStr);
    const msg: CrewMessage = {
      group,
      hostname: os.hostname(),
      sessions,
    };
    const result = await postToRelay(url, msg);
    return result.sessions;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("ECONNREFUSED") && !msg.includes("timeout")) {
      log.warn(`Relay client: ${msg}`);
    }
    return [];
  }
}

async function getCommitSha(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { encoding: "utf-8", timeout: 3000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function isTreeDirty(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { encoding: "utf-8", timeout: 3000 });
    return stdout.trim().length > 0;
  } catch {
    return true;
  }
}

export async function pushBlocks(group: string): Promise<number> {
  const urlStr = relayUrl();
  if (!urlStr) return 0;

  const [sha, dirty] = await Promise.all([getCommitSha(), isTreeDirty()]);
  if (!sha || dirty) return 0;

  const blocks: BlockEntry[] = [];
  for (const source of BLOCK_SOURCES) {
    if (!isSharedBlock(source)) continue;
    const cached = readCache(source);
    if (cached) {
      blocks.push({ source, data: cached.data, timestamp: cached.timestamp, hash: cached.hash });
    }
  }

  if (blocks.length === 0) return 0;

  try {
    const url = new URL(urlStr);
    const msg: BlockPushMessage = { group, hostname: os.hostname(), commitSha: sha, blocks };
    const data = JSON.stringify(msg);

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: url.hostname, port: url.port || 9741, path: "/blocks", method: "POST", timeout: 5000, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`push blocks responded ${res.statusCode}`));
            } else {
              resolve();
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("push blocks timeout")); });
      req.write(data);
      req.end();
    });

    log.info(`Relay client: pushed ${blocks.length} block(s) for ${group}@${sha.substring(0, 8)}`);
    return blocks.length;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("ECONNREFUSED") && !msg.includes("timeout")) {
      log.warn(`Relay client push blocks: ${msg}`);
    }
    return 0;
  }
}

export async function fetchBlocks(group: string, commitSha: string): Promise<BlockEntry[]> {
  const urlStr = relayUrl();
  if (!urlStr || !commitSha) return [];

  try {
    const url = new URL(urlStr);
    const path = `/blocks?group=${encodeURIComponent(group)}&commitSha=${encodeURIComponent(commitSha)}`;

    return await new Promise<BlockEntry[]>((resolve, reject) => {
      const req = http.request(
        { hostname: url.hostname, port: url.port || 9741, path, method: "GET", timeout: 5000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              resolve([]);
              return;
            }
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
              resolve(Array.isArray(parsed.blocks) ? parsed.blocks : []);
            } catch {
              resolve([]);
            }
          });
        },
      );
      req.on("error", () => resolve([]));
      req.on("timeout", () => { req.destroy(); resolve([]); });
      req.end();
    });
  } catch {
    return [];
  }
}

export function startRelayClient(
  group: string,
  getLocalSessions: () => CrewSession[],
) {
  if (pollTimer) return;
  if (!relayUrl()) return;

  let consecutiveErrors = 0;

  const poll = async () => {
    try {
      const local = getLocalSessions();
      const remote = await syncWithRelay(group, local);
      setCrewRemoteSessions(remote);
      await pushBlocks(group);
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      if (consecutiveErrors <= 3 || consecutiveErrors % 10 === 0) {
        log.warn(`Relay client poll error (${consecutiveErrors}): ${msg}`);
      }
    }
  };

  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

export function stopRelayClient() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  setCrewRemoteSessions([]);
}
