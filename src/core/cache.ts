import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { log, errMsg } from "./logger.js";
import { computePayloadHash } from "./injection-types.js";
import { atomicWrite } from "./fs-utils.js";

export interface CacheEntry {
  key: string;
  data: string;
  hash: string;
  timestamp: number;
  ttl: number;
  metadata?: Record<string, string>;
}

export const CACHE_DIR = ".pipemd/cache/sources";
export const VALIDATION_DIR = ".pipemd/cache/validation";
const CACHE_MANIFEST = ".pipemd/cache/manifest.json";
const MEM_CACHE_TTL = 3_000;
const memCache = new Map<string, { data: CacheEntry | null; expires: number; mtime: number }>();

function evictMemCache(): void {
  if (memCache.size <= 128) return;
  const now = Date.now();
  for (const [key, entry] of memCache) {
    if (entry.expires <= now) memCache.delete(key);
  }
}

export const DEFAULT_TTLS: Record<string, number> = {
  crew: 5000,
  lint: 30000,
  "type-check": 30000,
  "git-status": 10000,
  "git-delta": 10000,
  validation: 60000,
  tree: 120000,
  deps: 120000,
  arch: 300000,
  todos: 60000,
  "syntax-check": 10000,
  "edit-diff": 5000,
  "test-failures": 60000,
  "import-graph": 30000,
  "exports": 30000,
};

function keyToFilename(key: string): string {
  return key.replace(/[/\\]/g, "%2F") + ".json";
}

function entryPath(key: string): string {
  const filename = keyToFilename(key);
  if (key.startsWith("validation:")) {
    return resolve(VALIDATION_DIR, filename);
  }
  return resolve(CACHE_DIR, filename);
}

export function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  if (!existsSync(VALIDATION_DIR)) {
    mkdirSync(VALIDATION_DIR, { recursive: true });
  }
  const manifestDir = resolve(CACHE_MANIFEST, "..");
  if (!existsSync(manifestDir)) {
    mkdirSync(manifestDir, { recursive: true });
  }
}

export function readCache(key: string): CacheEntry | null {
  const memEntry = memCache.get(key);
  if (memEntry && memEntry.expires > Date.now()) {
    try {
      const currentMtime = statSync(entryPath(key)).mtimeMs;
      if (currentMtime !== memEntry.mtime) {
        memCache.delete(key);
      } else {
        if (memEntry.data && Date.now() - memEntry.data.timestamp > memEntry.data.ttl) {
          memCache.delete(key);
          return null;
        }
        return memEntry.data;
      }
    } catch {
      memCache.delete(key);
      return null;
    }
  }
  const path = entryPath(key);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const stat = statSync(path);
    const raw = readFileSync(path, "utf-8");
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.timestamp > entry.ttl) {
      return null;
    }
    memCache.set(key, { data: entry, expires: Date.now() + MEM_CACHE_TTL, mtime: stat.mtimeMs });
    evictMemCache();
    return entry;
  } catch (err: unknown) { log.debug(`readCache parse failed: ${errMsg(err)}`); return null; }
}

export function writeCache(
  key: string,
  data: string,
  ttl: number,
  metadata?: Record<string, string>,
): CacheEntry {
  ensureCacheDir();
  const hash = computePayloadHash(data);
  const entry: CacheEntry = {
    key,
    data,
    hash,
    timestamp: Date.now(),
    ttl,
    ...(metadata ? { metadata } : {}),
  };
  const path = entryPath(key);
  atomicWrite(path, JSON.stringify(entry));
  try {
    const stat = statSync(path);
    memCache.set(key, { data: entry, expires: Date.now() + MEM_CACHE_TTL, mtime: stat.mtimeMs });
  } catch {}
  return entry;
}

export function isFresh(key: string): boolean {
  return readCache(key) !== null;
}

export function invalidate(key: string): void {
  memCache.delete(key);
  const p = entryPath(key);
  if (existsSync(p)) {
    unlinkSync(p);
  }
}

export function invalidateCachePattern(pattern: string): number {
  let count = 0;
  for (const [key] of memCache) {
    if (key.includes(pattern)) memCache.delete(key);
  }
  const dirs = [CACHE_DIR, VALIDATION_DIR];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        if (file.includes(pattern)) {
          try { unlinkSync(resolve(dir, file)); count++; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  return count;
}
