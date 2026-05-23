import fs from "node:fs";
import path from "node:path";
import { reapStaleSessions, DEFAULT_STALE_MS, listSessions as listLocalSessions } from "./crew.js";
import { writeDashboard, resetDaemonStart } from "./dashboard.js";
import { ensureCacheDir } from "./cache.js";
import { purgeOldRecords } from "./dedup.js";
import { log } from "./logger.js";
import type { PipeConfig } from "../config.js";
import { PID_FILE, INJECTION_LOG_DIR, LIVE_DIR } from "./paths.js";
import { startRelayClient, stopRelayClient } from "./net/daemon-client.js";
import { loadConfig, ConfigError } from "./daemon-config.js";
import {
  trackedSetInterval,
  checkMkfifo,
  resolvePipePath,
  createPipe,
  serveContextPipe,
  serveCommandPipe,
  shutdownPipes,
  setShuttingDown,
} from "./pipe-manager.js";
import { startLegacyWatcher } from "./legacy-watcher.js";

const INJECTION_LOG_MAX_AGE_MS = 3_600_000;

function cleanInjectionLog(maxAgeMs: number = INJECTION_LOG_MAX_AGE_MS): void {
  if (!fs.existsSync(INJECTION_LOG_DIR)) return;
  const now = Date.now();
  let entries: string[];
  try {
    entries = fs.readdirSync(INJECTION_LOG_DIR);
  } catch {
    return;
  }
  for (const file of entries) {
    if (file === "last.txt") continue;
    const fullPath = path.join(INJECTION_LOG_DIR, file);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fullPath);
      }
    } catch (err: unknown) { log.debug(`cleanInjectionLog stat failed: ${err instanceof Error ? err.message : String(err)}`); }
  }
}

const writeBackGuard = { value: false };

function runPipeMode(config: PipeConfig) {
  log.info("Pipe mode: mkfifo available");

  const allPipePaths: string[] = [];
  for (const pipe of config.pipes) {
    const pipePath = resolvePipePath(pipe.file, pipe);
    const created = createPipe(pipePath);
    if (created) {
      allPipePaths.push(pipePath);
    }
  }

  for (const pipe of config.pipes) {
    const pipePath = resolvePipePath(pipe.file, pipe);
    if (!fs.existsSync(pipePath)) continue;

    if (pipe.render) {
      serveContextPipe(pipePath, pipe.render, config, writeBackGuard);
    } else if (pipe.command) {
      serveCommandPipe(pipePath, pipe.command, config);
    }
  }

  return allPipePaths;
}

function shutdown(allPipePaths: string[]) {
  setShuttingDown(true);
  log.info("Daemon shutting down...");

  shutdownPipes();

  for (const p of allPipePaths) {
    try { fs.unlinkSync(p); } catch {}
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}

export function runDaemon() {
  log.info("PipeMD daemon starting...");

  process.on("SIGPIPE", () => {});

  let config: PipeConfig
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.exit(1)
    }
    throw err
  }
  resetDaemonStart();

  fs.mkdirSync(LIVE_DIR, { recursive: true });
  ensureCacheDir();

  if (config.commands && config.commands["crew"]) {
    const crewStaleMs = config.settings?.crew?.staleMs ?? DEFAULT_STALE_MS;
    trackedSetInterval(() => {
      try {
        const reaped = reapStaleSessions(crewStaleMs);
        if (reaped.length) {
          log.info(`Crew: reaped ${reaped.length} stale session(s)`);
          writeDashboard();
        }
      } catch (err) {
        log.warn(`Crew reap failed: ${err}`);
      }
    }, 30_000);

    writeDashboard();
    trackedSetInterval(writeDashboard, 5_000);
  }

  trackedSetInterval(() => {
    try { purgeOldRecords(); } catch (err: unknown) { log.debug(`purgeOldRecords failed: ${err instanceof Error ? err.message : String(err)}`); }
  }, 300_000);

  trackedSetInterval(() => {
    try { cleanInjectionLog(); } catch (err: unknown) { log.debug(`cleanInjectionLog failed: ${err instanceof Error ? err.message : String(err)}`); }
  }, 300_000);

  const hasMkfifo = checkMkfifo();

  const pipeModePipes = config.pipes.filter((p) => {
    if (p.mode === "legacy") return false;
    if (p.mode === "pipe") return true;
    return hasMkfifo;
  });

  const legacyModePipes = config.pipes.filter((p) => {
    if (p.mode === "pipe") return false;
    if (p.mode === "legacy") return true;
    return !hasMkfifo;
  });

  let allPipePaths: string[] = [];

  if (legacyModePipes.length > 0) {
    const legacyConfig: PipeConfig = { ...config, pipes: legacyModePipes };
    startLegacyWatcher(legacyConfig, writeBackGuard);
  }

  if (pipeModePipes.length > 0 && hasMkfifo) {
    const pipeConfig: PipeConfig = { ...config, pipes: pipeModePipes };
    allPipePaths = runPipeMode(pipeConfig);
  } else if (legacyModePipes.length === 0) {
    startLegacyWatcher(config, writeBackGuard);
  }

  process.on("SIGTERM", () => { stopRelayClient(); shutdown(allPipePaths); });
  process.on("SIGINT", () => { stopRelayClient(); shutdown(allPipePaths); });
  process.on("SIGHUP", () => {});

  const relayUrl = config.link?.relay || process.env.PMD_RELAY;
  if (relayUrl) {
    const groupName = config.link?.group || process.env.PMD_GROUP || path.basename(process.cwd());
    startRelayClient(groupName, () => {
      const all = listLocalSessions();
      return all.filter((s) => !s._remote);
    });
    log.info(`Relay client started: ${relayUrl} (group: ${groupName})`);
  }

  process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    shutdown(allPipePaths);
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.error(`Unhandled rejection: ${msg}`);
    shutdown(allPipePaths);
  });

  log.info("Daemon running.");
}

export function writePidFile(pid: number) {
  fs.writeFileSync(PID_FILE, String(pid), "utf-8");
}

export function readPidFile(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}
