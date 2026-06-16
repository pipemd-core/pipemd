import fs from "node:fs";
import { log, errMsg } from "./logger.js";

export function tryReadJson<T = Record<string, unknown>>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch (err: unknown) { log.debug(`tryReadJson failed for ${p}: ${errMsg(err)}`); return null; }
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return e instanceof Error && (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readInjectStats(statsFile: string): { delivered: number; dedup: number; lastEvent?: Record<string, unknown> } {
  const s = tryReadJson(statsFile);
  return {
    delivered: typeof s?.delivered === "number" ? s.delivered : 0,
    dedup: typeof s?.dedup === "number" ? s.dedup : 0,
    lastEvent: s?.lastEvent as Record<string, unknown> | undefined,
  };
}

export function formatTimeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 0) return "just now";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

const SAFE_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TZ",
  "LC_ALL", "LC_CTYPE", "LC_NUMERIC", "LC_TIME", "LC_COLLATE", "LC_MONETARY", "LC_MESSAGES",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "PMD_BIN", "PMD_RELAY", "PMD_GROUP", "PMD_SESSION", "PMD_ASTGREP", "PMD_CREW_ROLE", "PMD_CREW_COORDINATOR",
]);

export function buildSafeEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SAFE_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }
  if (extra) Object.assign(env, extra);
  return env;
}
