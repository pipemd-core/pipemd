import { Command } from "commander";
import chalk from "chalk";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { DEFAULT_PORT } from "../core/net/protocol.js";
import { log } from "../core/logger.js";

const LINK_DIR = path.join(os.homedir(), ".pipemd", "link");
const PID_FILE = path.join(LINK_DIR, "relay.pid");
const TOKEN_FILE = path.join(LINK_DIR, "relay.token");
const PORT_FILE = path.join(LINK_DIR, "relay.port");
const PEERS_FILE = path.join(LINK_DIR, "peers.json");

function ensureLinkDir() {
  fs.mkdirSync(LINK_DIR, { recursive: true });
}

function readRelayPid(): number | null {
  try {
    return parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10) || null;
  } catch {
    return null;
  }
}

function isRelayRunning(): boolean {
  const pid = readRelayPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return false;
  }
}

function readRelayPort(): number {
  try {
    return parseInt(fs.readFileSync(PORT_FILE, "utf-8").trim(), 10) || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

function readOrGenerateToken(): string {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return fs.readFileSync(TOKEN_FILE, "utf-8").trim();
    }
  } catch (err: unknown) { log.debug(`read existing token failed: ${err instanceof Error ? err.message : String(err)}`); }
  const token = crypto.randomBytes(16).toString("hex");
  ensureLinkDir();
  fs.writeFileSync(TOKEN_FILE, token, "utf-8");
  return token;
}

function readPeers(): { host: string; token: string }[] {
  try {
    if (!fs.existsSync(PEERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(PEERS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writePeers(peers: { host: string; token: string }[]) {
  ensureLinkDir();
  fs.writeFileSync(PEERS_FILE, JSON.stringify(peers, null, 2), "utf-8");
}

function startRelayProcess(): number {
  const selfPath = process.argv[1];
  const child = spawn(process.execPath, [selfPath, "_linkd"], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? 0;
}

function httpGet(urlStr: string): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const req = http.get(
        { hostname: url.hostname, port: url.port || DEFAULT_PORT, path: url.pathname || "/health", timeout: 3000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve({ ok: res.statusCode === 200, data: JSON.parse(Buffer.concat(chunks).toString("utf-8")) });
            } catch {
              resolve({ ok: res.statusCode === 200, data: null });
            }
          });
        },
      );
      req.on("error", () => resolve({ ok: false, data: null }));
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, data: null }); });
    } catch {
      resolve({ ok: false, data: null });
    }
  });
}

function httpGetStatus(host: string, token?: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    try {
      const lastColon = host.lastIndexOf(":");
      const h = host.slice(0, lastColon);
      const portStr = host.slice(lastColon + 1);
      const port = parseInt(portStr || "9741", 10);
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const req = http.get({ hostname: h, port, path: "/status", timeout: 3000, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch {
            resolve(null);
          }
        });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

async function doStart(): Promise<string | null> {
  if (isRelayRunning()) {
    return chalk.dim(`Relay already running (PID ${readRelayPid()}, port ${readRelayPort()})`);
  }

  ensureLinkDir();
  const pid = startRelayProcess();

  for (let i = 0; i < 20; i++) {
    const check = readRelayPid();
    if (check && (() => { try { process.kill(check, 0); return true; } catch { return false; } })()) {
      const port = readRelayPort();
      return chalk.green(`✔ Relay started (PID ${check}, port ${port})`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return chalk.yellow("⚠ Relay may not have started. Check with `pmd link --list`");
}

function formatLinkHelp(): string {
  const lines: string[] = [];
  const w = (name: string, desc: string) =>
    `  ${chalk.cyan(name.padEnd(22))}${chalk.dim(desc)}`;

  lines.push(chalk.bold("Usage:"));
  lines.push(w("pmd link", "Start relay and show invite command"));
  lines.push(w("pmd link <host:port>", "Connect to a remote relay"));
  lines.push("");
  lines.push(chalk.bold("Options:"));
  lines.push(w("--token <token>", "Auth token for the remote relay"));
  lines.push(w("--list", "Show relay status and connected peers"));
  lines.push(w("--disconnect <host>", "Remove a peer connection"));
  lines.push(w("--stop", "Stop the relay process"));
  lines.push("");
  return "\n" + lines.join("\n") + "\n";
}

const link = new Command("link")
  .description("[Beta] Connect PipeMD daemons across machines and Docker containers (experimental)")
  .configureHelp({ visibleCommands: () => [] })
  .addHelpText("after", formatLinkHelp());

link
  .command("start", { hidden: true })
  .action(async () => {
    const msg = await doStart();
    if (msg) console.log(msg);
  });

link
  .option("--token <token>", "auth token for remote relay")
  .option("--list", "show relay status and connected peers")
  .option("--disconnect <host>", "remove a peer connection")
  .option("--stop", "stop the relay process")
  .argument("[host]", "remote relay address (host:port)")
  .action(async (host: string | undefined, opts: { token?: string; list?: boolean; disconnect?: string; stop?: boolean }) => {
    if (opts.stop) {
      const pid = readRelayPid();
      if (pid) {
        try { process.kill(pid, "SIGTERM"); } catch {}
        console.log(chalk.green(`✔ Relay stopped (PID ${pid})`));
      } else {
        console.log(chalk.dim("No relay running."));
      }
      return;
    }

    if (opts.disconnect) {
      const peers = readPeers().filter((p) => p.host !== opts.disconnect);
      writePeers(peers);
      console.log(chalk.green(`✔ Disconnected from ${opts.disconnect}`));
      return;
    }

    if (opts.list) {
      const running = isRelayRunning();
      const port = readRelayPort();
      const pid = readRelayPid();

      console.log(chalk.bold("Relay:"));
      if (running) {
        console.log(chalk.green(`  ✔ Running (PID ${pid}, port ${port})`));
      } else {
        console.log(chalk.dim("  Not running"));
      }

      const peers = readPeers();
      if (peers.length > 0) {
        console.log(chalk.bold("\nPeers:"));
        for (const p of peers) {
          const status = await httpGetStatus(p.host, p.token);
          if (status && status.ok) {
            const groupNames = Object.keys(status.groups || {});
            const totalAgents = Object.values(status.groups || {}).reduce((sum: number, g: any) => sum + (g.local || 0) + (g.remote || 0), 0);
            console.log(chalk.green(`  ✔ ${p.host}`) + chalk.dim(` — ${totalAgents} agents, groups: ${groupNames.join(", ") || "none"}`));
          } else {
            console.log(chalk.red(`  ✖ ${p.host}`) + chalk.dim(" — unreachable"));
          }
        }
      } else {
        console.log(chalk.dim("\n  No peers configured."));
      }

      if (running) {
        const localStatus = await httpGetStatus(`localhost:${port}`);
        if (localStatus && localStatus.groups) {
          const groups = localStatus.groups;
          const names = Object.keys(groups);
          if (names.length > 0) {
            console.log(chalk.bold("\nGroups:"));
            for (const [name, info] of Object.entries(groups)) {
              const g = info as { local: number; remote: number };
              console.log(`  ${chalk.cyan(name)} — ${g.local} local, ${g.remote} remote`);
            }
          }
        }
      }
      return;
    }

    if (host) {
      const { ok } = await httpGet(`http://${host}/health`);
      if (!ok) {
        console.log(chalk.red(`✖ Cannot reach ${host}. Is the relay running there?`));
        process.exit(1);
      }

      const peerToken = opts.token || "";
      const peers = readPeers();
      if (!peers.find((p) => p.host === host)) {
        peers.push({ host, token: peerToken });
        writePeers(peers);
      }

      if (!isRelayRunning()) {
        await doStart();
      }

      console.log(chalk.green(`✔ Connected to ${host}`));
      console.log(chalk.dim("  Crew sessions will sync bidirectionally within 5 seconds."));
      return;
    }

    if (!isRelayRunning()) {
      await doStart();
    }

    const token = readOrGenerateToken();
    const port = readRelayPort();
    const h = os.hostname();

    console.log();
    console.log(chalk.green(`✔ Token: ${token}`));
    console.log(chalk.green(`✔ Relay: ${h}:${port}`));
    console.log();
    console.log("On the other machine, run:");
    console.log(chalk.cyan(`  pmd link ${h}:${port} --token ${token}`));
    console.log();
  });

export const linkCommand = link;
