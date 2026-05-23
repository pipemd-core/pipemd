import http from "node:http";
import os from "node:os";
import type { CrewSession } from "../crew.js";
import { log } from "../logger.js";
import { type CrewMessage, POLL_INTERVAL_MS } from "./protocol.js";

export interface RemoteSession extends CrewSession {
  _remote: true;
  _origin: string;
}

let remoteCache: RemoteSession[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function setRemoteSessions(sessions: RemoteSession[]) {
  remoteCache = sessions;
}

export function getRemoteSessions(): RemoteSession[] {
  return remoteCache;
}

export function clearRemoteSessions() {
  remoteCache = [];
}

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
            const sessions = (parsed.sessions || []).map((s: any) => ({
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

export function startRelayClient(
  group: string,
  getLocalSessions: () => CrewSession[],
) {
  if (pollTimer) return;
  if (!relayUrl()) return;

  const poll = async () => {
    try {
      const local = getLocalSessions();
      const remote = await syncWithRelay(group, local);
      setRemoteSessions(remote);
    } catch {}
  };

  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

export function stopRelayClient() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  clearRemoteSessions();
}
