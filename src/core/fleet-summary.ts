import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { CONFIG_PATH } from "./paths.js";
import { log, errMsg } from "./logger.js";

const FLEET_TIMEOUT_MS = 3_000;

interface FleetMachine {
  hostname?: string;
  name?: string;
  machine?: string;
  projects?: unknown[];
  sessions?: unknown[];
  ptys?: unknown[];
}

function readRelayUrl(): string | null {
  const envRelay = process.env.PMD_RELAY;
  if (envRelay) return envRelay;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = parseYaml(fs.readFileSync(CONFIG_PATH, "utf-8")) as
        | { link?: { relay?: string } }
        | null;
      if (config?.link?.relay) return config.link.relay;
    }
  } catch (err: unknown) {
    log.debug(`fleet: read relay url: ${errMsg(err)}`);
  }
  return null;
}

function readRelayToken(): string {
  try {
    const tokenFile = path.join(os.homedir(), ".pipemd", "link", "relay.token");
    if (fs.existsSync(tokenFile)) {
      return fs.readFileSync(tokenFile, "utf-8").trim();
    }
  } catch (err: unknown) {
    log.debug(`fleet: read token: ${errMsg(err)}`);
  }
  return "";
}

function fetchFleet(relayUrl: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(`${relayUrl.replace(/\/$/, "")}/fleet`);
    } catch (err: unknown) {
      reject(new Error(`invalid relay URL: ${errMsg(err)}`));
      return;
    }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || 9741,
        path: url.pathname,
        method: "GET",
        timeout: FLEET_TIMEOUT_MS,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`relay responded ${res.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString("utf-8"));
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("relay timeout"));
    });
    req.end();
  });
}

function extractMachines(data: unknown): FleetMachine[] {
  if (Array.isArray(data)) return data as FleetMachine[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.machines)) return obj.machines as FleetMachine[];
    if (Array.isArray(obj.fleet)) return obj.fleet as FleetMachine[];
  }
  return [];
}

function formatFleet(data: unknown): string {
  const machines = extractMachines(data);
  if (machines.length === 0) return "(fleet empty or unreachable)";

  const lines: string[] = [];
  for (const m of machines) {
    const name = m.hostname || m.name || m.machine || "unknown";
    const sessions = m.sessions || m.projects || [];
    const ptys = m.ptys || [];
    lines.push(`\u25b8 ${name}`);
    if (Array.isArray(sessions)) {
      for (const s of sessions) {
        const sm = s as Record<string, unknown>;
        const id = String(sm.id || sm.agentId || sm.sessionId || "");
        const role = String(sm.role || sm.harness || "");
        const label = String(sm.label || "");
        const parts = [id, role, label].filter(Boolean);
        if (parts.length > 0) lines.push(`  ${parts.join(" \u00b7 ")}`);
      }
    }
    if (Array.isArray(ptys) && ptys.length > 0) {
      lines.push(`  PTYs: ${ptys.length} active`);
    }
  }
  return lines.join("\n");
}

/**
 * Pull-based fleet summary for the daemon's render pipeline.
 * Fetches `GET {relay}/fleet` (Bearer token from ~/.pipemd/link/relay.token)
 * and returns a compact topology string. Returns an empty string on any
 * failure (no relay configured, unreachable, parse error) so the rendering
 * block is silently omitted — never blocks the render.
 */
export async function renderFleetSummary(): Promise<string> {
  const relayUrl = readRelayUrl();
  if (!relayUrl) return "";

  const token = readRelayToken();

  let body: string;
  try {
    body = await fetchFleet(relayUrl, token);
  } catch (err: unknown) {
    log.debug(`fleet: fetch failed: ${errMsg(err)}`);
    return "";
  }

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (err: unknown) {
    log.debug(`fleet: parse failed: ${errMsg(err)}`);
    return "";
  }

  return formatFleet(data);
}
