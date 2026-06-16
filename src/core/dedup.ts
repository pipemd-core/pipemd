import { mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync, statSync, openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { computePayloadHash } from "./injection-types.js";
import { atomicWrite } from "./fs-utils.js";
import { log, errMsg } from "./logger.js";
import { isPidAlive } from "./json-utils.js";
import { TtlCache } from "./ttl-cache.js";

type SessionStore = Record<string, { hash: string; timestamp: number }>;

export const INJECTED_DIR = ".pipemd/cache/injected";

const MEM_CACHE_TTL = 2_000;
const MEM_CACHE_MAX_ENTRIES = 128;
const DEDUP_SOURCE_TTL_MS = 120_000;

const memCache = new Map<string, TtlCache<SessionStore>>();

export function clearMemCache(): void {
  memCache.clear();
}

function evictMemCache(): void {
  if (memCache.size <= MEM_CACHE_MAX_ENTRIES) return;
  for (const [key, cache] of memCache) {
    if (cache.get() === null) memCache.delete(key);
  }
}

export function ensureInjectedDir(): void {
  mkdirSync(INJECTED_DIR, { recursive: true });
}

function sessionPath(sessionId: string): string {
  return join(INJECTED_DIR, `${sessionId}.json`);
}

function loadSession(sessionId: string): SessionStore {
  let cache = memCache.get(sessionId);
  if (!cache) {
    cache = new TtlCache<SessionStore>(MEM_CACHE_TTL);
    memCache.set(sessionId, cache);
  }
  const cached = cache.get();
  if (cached !== null) return cached;
  const p = sessionPath(sessionId);
  let store: SessionStore = {};
  if (existsSync(p)) {
    try {
      store = JSON.parse(readFileSync(p, "utf8"));
    } catch (err: unknown) {
      log.debug(`loadSession parse failed: ${errMsg(err)}`);
      store = {};
    }
  }
  cache.set(store);
  evictMemCache();
  return store;
}

function saveSession(sessionId: string, store: SessionStore): void {
  ensureInjectedDir();
  atomicWrite(sessionPath(sessionId), JSON.stringify(store));
  const cache = memCache.get(sessionId);
  if (cache) cache.set(store);
  else memCache.set(sessionId, (() => { const c = new TtlCache<SessionStore>(MEM_CACHE_TTL); c.set(store); return c; })());
}

export function recordInjection(sessionId: string, source: string, content: string): void {
  const lockPath = sessionPath(sessionId) + ".lock";
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try { writeSync(fd, String(process.pid)); } catch {}
      closeSync(fd);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const lockPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
          if (!isNaN(lockPid) && !isPidAlive(lockPid)) {
            try { unlinkSync(lockPath); } catch {}
            continue;
          }
        } catch {
          try { unlinkSync(lockPath); } catch {}
          continue;
        }
        const end = Date.now() + 5 + Math.floor(Math.random() * 15);
        while (Date.now() < end) {}
        continue;
      }
      break;
    }

    try {
      const store = loadSession(sessionId);
      store[source] = { hash: computePayloadHash(content), timestamp: Date.now() };
      saveSession(sessionId, store);
      return;
    } finally {
      try { unlinkSync(lockPath); } catch {}
    }
  }
  const store = loadSession(sessionId);
  store[source] = { hash: computePayloadHash(content), timestamp: Date.now() };
  saveSession(sessionId, store);
}

export function checkInjectionStatus(
  sessionId: string,
  source: string,
  content: string,
): "new" | "changed" | "unchanged" {
  const store = loadSession(sessionId);
  const entry = store[source];
  if (!entry) return "new";
  const hash = computePayloadHash(content);
  if (hash === entry.hash) {
    if (Date.now() - entry.timestamp > DEDUP_SOURCE_TTL_MS) return "changed";
    return "unchanged";
  }
  return "changed";
}

export function getLastInjectedHash(sessionId: string, source: string): string | null {
  const store = loadSession(sessionId);
  return store[source]?.hash ?? null;
}

export function clearSessionRecords(sessionId: string): void {
  const p = sessionPath(sessionId);
  if (existsSync(p)) {
    unlinkSync(p);
  }
}

export function purgeOldRecords(maxAgeMs: number = 3600000): void {
  ensureInjectedDir();
  const now = Date.now();
  let entries: string[];
  try {
    entries = readdirSync(INJECTED_DIR);
  } catch (err: unknown) {
    log.debug(`purgeOldRecords readdir failed: ${errMsg(err)}`);
    return;
  }
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    const fullPath = join(INJECTED_DIR, file);
    try {
      const stat = statSync(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(fullPath);
      }
    } catch (err: unknown) { log.debug(`purgeOldRecords stat/unlink failed: ${errMsg(err)}`); }
  }
}
