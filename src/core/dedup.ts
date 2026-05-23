import { mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { computePayloadHash } from "./injection-types.js";
import { atomicWrite } from "./fs-utils.js";

export interface InjectedRecord {
  sessionId: string;
  source: string;
  hash: string;
  timestamp: number;
  content?: string;
}

type SessionStore = Record<string, { hash: string; timestamp: number }>;

export const INJECTED_DIR = ".pipemd/cache/injected";

const memCache = new Map<string, { ts: number; store: SessionStore }>();
const MEM_CACHE_TTL = 2_000;

export function clearMemCache(): void {
  memCache.clear();
}

export function ensureInjectedDir(): void {
  mkdirSync(INJECTED_DIR, { recursive: true });
}

function sessionPath(sessionId: string): string {
  return join(INJECTED_DIR, `${sessionId}.json`);
}

function loadSession(sessionId: string): SessionStore {
  const now = Date.now();
  const cached = memCache.get(sessionId);
  if (cached && now - cached.ts < MEM_CACHE_TTL) return cached.store;
  const p = sessionPath(sessionId);
  let store: SessionStore = {};
  if (existsSync(p)) {
    try {
      store = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      store = {};
    }
  }
  memCache.set(sessionId, { ts: now, store });
  return store;
}

function saveSession(sessionId: string, store: SessionStore): void {
  ensureInjectedDir();
  atomicWrite(sessionPath(sessionId), JSON.stringify(store));
  memCache.set(sessionId, { ts: Date.now(), store });
}

export function recordInjection(sessionId: string, source: string, content: string): void {
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
  return hash === entry.hash ? "unchanged" : "changed";
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
  } catch {
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
    } catch {
      // ignore
    }
  }
}
