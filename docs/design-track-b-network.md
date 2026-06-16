# Track B: PipeMD Networking Architecture — Design Spec

> **Task:** t_f57607ea (Kanban: pipemd board)
> **Status:** Design / Spec — ready for implementation (T4: empire-dev)
> **Date:** 2026-06-16
> **Branch target:** `feat/hermes-network`
> **Anti-fabrication note:** Every function in `relay.ts` (464 LOC) was audited against actual source. Test coverage assessed against the 4 existing test files. State assessments are grounded in code, not assumptions.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [relay.ts — Function-by-Function Audit](#2-relayts--function-by-function-audit)
3. [daemon-client.ts — Audit](#3-daemon-clientts--audit)
4. [Critical Issues & Blockers Before Unfreezing](#4-critical-issues--blockers-before-unfreezing)
5. [Block Federation Design](#5-block-federation-design)
6. [Crew Broadcast Across Machines](#6-crew-broadcast-across-machines)
7. [Peer Discovery Protocol (v1: static peers)](#7-peer-discovery-protocol-v1-static-peers)
8. [HTTP Endpoint Extensions](#8-http-endpoint-extensions)
9. [Test File Structure](#9-test-file-structure)
10. [UFW / Security Considerations](#10-ufw--security-considerations)
11. [Implementation Sequence](#11-implementation-sequence)

---

## 1. Executive Summary

The relay (`src/core/net/relay.ts`) is architecturally sound but operationally frozen for cross-machine use. The core blocker is a single line: `server.listen(port, "127.0.0.1", ...)` (line 393) — the relay binds to localhost only, making peer-to-peer sync across the Empire LAN (192.168.1.72 ↔ 192.168.1.73) physically impossible without SSH tunnels.

The existing link docs (`docs/link.md`, `docs/link-architecture.md`) describe a relay-per-machine star topology where daemons push to a local relay via `/crew`, and relays sync with each other via `/sync` (token-authenticated). This design is correct and already partially implemented. The work needed is:

- **Unfreeze:** Fix the binding, peer config format, and dead-code paths.
- **Extend:** Add block federation to the peer-sync path (currently only crew sessions sync).
- **Enrich:** Add `/metrics` and a richer `/health`.
- **Test:** The existing `test-relay.ts` covers endpoints in isolation but has zero coverage for the cross-relay `/sync` outbound path (`syncWithPeers()`).

Three new test files are specified to close the gap.

---

## 2. relay.ts — Function-by-Function Audit

All 22 functions/exports in `relay.ts`, assessed against actual source (lines 1–464) and test coverage in `tests/test-relay.ts`.

### Utility Functions

| # | Function | Lines | State | Tested? | Notes |
|---|----------|-------|-------|---------|-------|
| 1 | `hostname()` | 32–34 | ✅ Works | Indirectly | Returns `os.hostname()`. Trivial. |
| 2 | `timingSafeEqual(a, b)` | 38–43 | ✅ Works | Indirectly via /sync tests | Wraps `crypto.timingSafeEqual`. Correct length check. |
| 3 | `isLocalhost(req)` | 45–48 | ✅ Works | ✅ via /crew tests | Checks `127.0.0.1`, `::1`, `::ffff:127.0.0.1`. Correct for IPv4/IPv6 loopback. |
| 4 | `readBody(req)` | 50–66 | ✅ Works | ✅ via /blocks invalid-JSON test | Body size cap at 1MB (`MAX_BODY_BYTES`). Destroys stream on overflow. Correct. |
| 5 | `jsonResponse(res, code, data)` | 68–75 | ✅ Works | ✅ all endpoints | Sets Content-Type + Content-Length. Correct. |
| 6 | `mergeSessionsFor(group, excludeOrigin)` | 77–92 | ✅ Works | ✅ /crew merge test | Flattens sessions from all origins except the requester. Tags with `_remote: true`, `_origin`. Correct. |
| 7 | `expireStaleGroups()` | 94–107 | ⚠️ Works, untested | ❌ NO | Deletes origins where `lastSeen > SESSION_EXPIRY_MS` (15s). Correct logic, but no test exercises TTL expiry with real time. **Gap.** |
| 8 | `expireBlockStore()` | 109–123 | ⚠️ Works, untested | ❌ NO | TTL 30min, max 1000, LRU eviction by timestamp. Correct logic, but no test exercises block expiry. **Gap.** |
| 9 | `readPeers()` | 125–132 | ⚠️ Works, format mismatch | ❌ NO | Reads `~/.pipemd/link/peers.json` (JSON). Plan calls for `peers.yml` (YAML). **Format mismatch with design.** |
| 10 | `enforceFilePermissions(filePath)` | 134–140 | ✅ Works | ❌ NO | `chmod 0600` for token/pid/port files. Correct. Hard to unit-test (fs.chmod mock needed). |
| 11 | `readToken()` | 142–153 | ✅ Works | Indirectly | Reads `~/.pipemd/link/relay.token`, trims, enforces 0600. Returns `""` if missing. Correct. |
| 12 | `enforceToken()` | 157–165 | ✅ Works | ❌ NO | Throws if no token found. **`cachedRelayToken` is set once and never invalidated** — token rotation requires relay restart. Minor for now. |

### Peer Sync

| # | Function | Lines | State | Tested? | Notes |
|---|----------|-------|-------|---------|-------|
| 13 | `syncWithPeers()` | 167–223 | 🔴 BROKEN for multi-machine | ❌ NO | **The most critical function for Track B.** Reads peers, builds `allGroups`, POSTs `/sync` to each peer. **BUG:** host parsing at lines 186–189 assumes `host:port` format. If `peer.host` is `"192.168.1.73"` (no port), `lastColon` = -1, `host` = `slice(0,-1)` = `"192.168.1.7"` (drops last char!), `port` = NaN → falls back to 9741 but connects to WRONG host. **Must fix.** Also: only syncs crew sessions (`allGroups`), never blocks. **No block federation.** |
| 14 | `cachedRelayToken` (module var) | 155 | ⚠️ Stale risk | — | Set on first `enforceToken()` call. Never refreshed. If token file changes after relay start, sync requests use the old token → auth failures. |

### Request Handlers

| # | Function | Lines | State | Tested? | Notes |
|---|----------|-------|-------|---------|-------|
| 15 | `handleCrew(req, res)` | 225–248 | ✅ Works | ✅ well tested | Localhost-only. Stores sessions by origin. Returns merged remote sessions. 5 test cases in test-relay.ts. |
| 16 | `handleSync(req, res)` | 250–287 | ✅ Works | ✅ 4 test cases | Token-authenticated. Receives remote groups, merges by `msg.hostname`, returns non-origin groups. **Correct anti-echo logic** (excludes requester's own hostname). |
| 17 | `handleStatus(req, res)` | 289–308 | ✅ Works | ✅ 1 test case | Returns group counts (local/remote) and peer sync timestamps. **No auth** — minor info disclosure on LAN. |
| 18 | `handleBlocksPush(req, res)` | 310–334 | ✅ Works | ✅ 4 test cases | Localhost-only. Validates group/hostname/commitSha/blocks. Stores by key `${group}:${commitSha}:${source}`. **No origin tracking** — blocks from different hostnames with same key overwrite. |
| 19 | `handleBlocksFetch(req, res)` | 336–360 | ✅ Works | ✅ 5 test cases | Localhost-only GET. Filters by `group:commitSha:` prefix. Correct. |
| 20 | `requestHandler(req, res)` | 362–378 | ✅ Works | ✅ routing tested | Router. **`/health` already exists** (line 373–374) but is minimal: `{ ok, hostname }`. Plan wants enrichment. `/metrics` does NOT exist. |

### Lifecycle

| # | Function | Lines | State | Tested? | Notes |
|---|----------|-------|-------|---------|-------|
| 21 | `startRelay(port)` | 380–404 | 🔴 BLOCKER | ✅ partial | **Binds to `"127.0.0.1"` only (line 393).** This makes cross-machine peer sync impossible — peer relays on other machines cannot reach this relay's `/sync` endpoint. Start/timer logic is correct. |
| 22 | `stopRelay()` | 406–421 | ✅ Works | ✅ via `after()` hook | Clears timers, closes server, clears block store. Correct. |
| 23 | `runRelay()` | 423–464 | ✅ Works | ❌ NO (process lifecycle) | Standalone runner. Creates link dir, enforces token, writes PID file, handles SIGTERM/SIGINT, resolves port from `PMD_LINK_PORT` env. Correct but untested (process management is hard to unit test). |

### Audit Summary

- **Functions working and tested:** 12
- **Functions working but untested:** 7 (expiry, peer sync, lifecycle)
- **Functions broken/blocked:** 2 (`syncWithPeers` host parsing, `startRelay` binding)
- **Dead code:** `fetchBlocks()` in `daemon-client.ts` (never called in poll loop — see §3)
- **Total relay.ts test coverage:** ~60% of endpoints exercised; **0% of peer-sync outbound path**

---

## 3. daemon-client.ts — Audit

`daemon-client.ts` (245 LOC) is the daemon-side HTTP client that talks to the local relay. Assessment against `tests/test-daemon-client.ts` and `tests/test-link.ts`.

| Function | Lines | State | Tested? | Notes |
|----------|-------|-------|---------|-------|
| `relayUrl()` | 21–23 | ✅ Works | ✅ | Reads `PMD_RELAY` env. Returns null if unset → local-only mode. |
| `postToRelay(url, body)` | 25–73 | ✅ Works | ✅ via syncWithRelay tests | Generic POST to relay, parses `{ sessions }` response, tags `_remote`/`_origin`. |
| `syncWithRelay(group, sessions)` | 75–98 | ✅ Works | ✅ 3 test cases | Pushes local sessions via `/crew`, returns remote sessions. Handles ECONNREFUSED/timeout silently. Correct. |
| `getCommitSha()` | 100–107 | ✅ Works | ❌ NO | `git rev-parse HEAD`. Returns `""` on failure. |
| `isTreeDirty()` | 100–116 | ✅ Works | ❌ NO | `git status --porcelain`. Returns `true` on failure (fail-safe). |
| `pushBlocks(group)` | 118–171 | ✅ Works | ❌ NO | Pushes shared blocks to `/blocks` when tree is clean and commit SHA exists. **Correctly only pushes `isSharedBlock()` sources.** |
| **`fetchBlocks(group, commitSha)`** | 173–208 | 🔴 **DEAD CODE** | ❌ NO | **Defined but NEVER called.** The poll loop (line 218–233) calls `syncWithRelay()` + `pushBlocks()` but never `fetchBlocks()`. Blocks are pushed to the relay but never pulled by the client. **This is why block federation doesn't work end-to-end.** |
| `startRelayClient(group, getLocalSessions)` | 210–237 | ⚠️ Works, no backoff | Indirectly | Poll loop every `POLL_INTERVAL_MS` (5s). `consecutiveErrors` only affects log verbosity (suppress after 3, then every 10th). **No exponential backoff.** Acceptable for 2-machine LAN but wasteful on partition. |
| `stopRelayClient()` | 239–245 | ✅ Works | ✅ | Clears timer, resets remote sessions. |

### Key Gaps

1. **`fetchBlocks()` is dead code.** It must be wired into the poll loop for block federation to work.
2. **No block-fetch trigger.** Even if wired in, the client needs to know WHICH commit SHA to fetch for — currently only tracks its own. Cross-machine SHA resolution is needed (§5).
3. **No reconnect event.** After a partition, the client just resumes polling. No "I'm back" signal to trigger an immediate full sync.

---

## 4. Critical Issues & Blockers Before Unfreezing

These must be fixed before any Track B feature work. Ordered by severity.

### B1. Relay binds to localhost only — CRITICAL BLOCKER

**Location:** `relay.ts:393`
```typescript
server.listen(port, "127.0.0.1", () => { ... });
```

**Impact:** Peer relays on other machines cannot reach `/sync`. Cross-machine federation is impossible without SSH tunnels (which the current docs recommend as a workaround).

**Fix:** Make the bind address configurable. Default to `0.0.0.0` when peers are configured, `127.0.0.1` when none (preserves single-machine safety).

```typescript
// New: read bind address from config/env
const bindAddress = process.env.PMD_LINK_BIND || "0.0.0.0";
server.listen(port, bindAddress, () => { ... });
```

**Security consideration:** Binding to `0.0.0.0` exposes `/sync` (token-protected), `/status`, and `/health` to the LAN. `/crew` and `/blocks` remain localhost-only. This is acceptable for the Empire's trusted LAN. For hostile networks, keep SSH tunnels. See §10.

### B2. `syncWithPeers()` host parsing bug — CRITICAL

**Location:** `relay.ts:186–189`
```typescript
const lastColon = peer.host.lastIndexOf(":");
const host = peer.host.slice(0, lastColon);
const portStr = peer.host.slice(lastColon + 1);
const port = parseInt(portStr || "9741", 10);
```

**Impact:** If `peer.host` = `"192.168.1.73"` (no port), `lastColon` = -1, `host` = `slice(0, -1)` = `"192.168.1.7"`. Connects to wrong machine.

**Fix:** Use `URL` parsing or explicit port field in `PeerConfig`:
```typescript
// Option A: PeerConfig gets explicit host + port fields
interface PeerConfig {
  host: string;    // "192.168.1.73"
  port: number;    // 9741
  token: string;
  label?: string;  // "workstation"
}
```

This also aligns with the plan's peer config shape: `{ host: "192.168.1.73", token: "...", label: "workstation" }`.

### B3. Peer config format: JSON vs YAML — MEDIUM

**Location:** `relay.ts:128` reads `~/.pipemd/link/peers.json`
**Plan:** `~/.pipemd/peers.yml`

**Decision:** Keep `peers.json` at `~/.pipemd/link/peers.json` for machine-level state (consistent with `relay.token`, `relay.pid`, `relay.port` which all live in `~/.pipemd/link/`). The `link/` directory is the canonical location for relay state. Do NOT introduce a new YAML file outside this directory.

**Rationale:** `peers.json` is machine-managed state (written by `pmd link <host>`), not human-edited config. JSON is the right format for programmatic read/write. YAML is for human-edited files like `config.yml`. The plan's `peers.yml` suggestion was conceptual; the existing architecture already uses `peers.json` correctly.

**Action:** Extend `PeerConfig` with `port` and `label` fields. Update `readPeers()` to validate the new shape. No format change needed.

### B4. `cachedRelayToken` never refreshed — LOW

**Location:** `relay.ts:155–165`

**Impact:** Token rotation requires relay restart. Acceptable for v1.

**Fix (deferred):** Add a file-watcher on `relay.token` or re-read on auth failure. Not blocking.

### B5. Block store has no origin tracking — MEDIUM (for federation)

**Location:** `relay.ts:326`
```typescript
const key: BlockKey = `${msg.group}:${msg.commitSha}:${block.source}`;
```

**Impact:** Blocks from different hostnames with same `(group, commitSha, source)` overwrite each other. For single-machine this is fine. For federation, blocks from exoserver and workstation with the same commit SHA would clobber.

**Fix:** Add origin to the key: `${msg.group}:${msg.commitSha}:${msg.hostname}:${block.source}`. See §5.

---

## 5. Block Federation Design

### Current State

Block push/fetch endpoints already exist in `relay.ts` (`/blocks` POST + GET). The daemon-client pushes blocks via `pushBlocks()`. But:

1. `fetchBlocks()` in `daemon-client.ts` is **dead code** — never called.
2. Blocks are not federated across relays — `syncWithPeers()` only syncs crew sessions.
3. No origin tracking in the block store key.

### Design: Two-Layer Federation

**Layer 1 — Local relay block store (already works):**
- Daemon pushes resolved blocks to local relay via `POST /blocks`.
- Relay stores in `blockStore` Map, keyed by `(group, commitSha, source)`.

**Layer 2 — Cross-relay block federation (NEW):**
- Extend `syncWithPeers()` to include blocks in the sync payload.
- Peer relays receive blocks and merge into their local store.
- Daemon clients fetch blocks from their local relay (wire up `fetchBlocks()`).

### Protocol Changes — `protocol.ts`

```typescript
// NEW: Block entry gains origin field
export interface BlockEntry {
  source: string;
  data: string;
  timestamp: number;
  hash: string;
  origin?: string;    // hostname that resolved the block
}

// EXTEND: SyncMessage includes blocks
export interface SyncMessage {
  hostname: string;
  groups: Record<string, CrewSession[]>;
  blocks?: BlockSyncPayload;   // NEW
}

// NEW: Block federation payload
export interface BlockSyncPayload {
  [groupCommitSha: string]: BlockEntry[];  // key: "group:commitSha"
}
```

### relay.ts Changes

**1. Block store key gains origin:**

```typescript
// BEFORE (line 326)
const key: BlockKey = `${msg.group}:${msg.commitSha}:${block.source}`;

// AFTER
type BlockKey = `${string}:${string}:${string}:${string}`;
const key: BlockKey = `${msg.group}:${msg.commitSha}:${msg.hostname}:${block.source}`;
```

**2. `syncWithPeers()` includes blocks in payload:**

```typescript
function syncWithPeers() {
  expireStaleGroups();

  const peers = readPeers();
  if (peers.length === 0) return;

  // ... existing group serialization ...

  // NEW: serialize block store
  const blockPayload: BlockSyncPayload = {};
  for (const [key, entry] of blockStore) {
    const [group, sha, origin, ...sourceParts] = key.split(":");
    const source = sourceParts.join(":");
    const compositeKey = `${group}:${sha}`;
    if (!blockPayload[compositeKey]) blockPayload[compositeKey] = [];
    blockPayload[compositeKey].push({ ...entry, origin });
  }

  const payload: SyncMessage = {
    hostname: myHostname,
    groups: allGroups,
    blocks: blockPayload,           // NEW
  };

  // ... existing HTTP request ...
}
```

**3. `handleSync()` merges received blocks:**

```typescript
// Inside handleSync, after merging groups:
if (msg.blocks) {
  for (const [compositeKey, entries] of Object.entries(msg.blocks)) {
    const [group, sha] = compositeKey.split(":");
    for (const block of entries) {
      const origin = block.origin || msg.hostname;
      const key: BlockKey = `${group}:${sha}:${origin}:${block.source}`;
      // Dedup: only store if newer than existing
      const existing = blockStore.get(key);
      if (!existing || existing.timestamp < block.timestamp) {
        blockStore.set(key, { source: block.source, data: block.data, timestamp: block.timestamp, hash: block.hash });
      }
    }
  }
}
```

**4. `handleBlocksFetch()` returns origin-tagged blocks:**

When a daemon fetches blocks, it gets blocks from ALL origins for that `(group, commitSha)`. This is the federation payoff — a daemon on workstation can fetch blocks resolved on exoserver.

### daemon-client.ts Changes

**Wire up `fetchBlocks()` in the poll loop:**

```typescript
const poll = async () => {
  try {
    const local = getLocalSessions();
    const remote = await syncWithRelay(group, local);
    setCrewRemoteSessions(remote);
    await pushBlocks(group);

    // NEW: fetch remote blocks if we have a commit SHA
    const sha = await getCommitSha();
    if (sha && !(await isTreeDirty())) {
      const remoteBlocks = await fetchBlocks(group, sha);
      // Inject remote blocks into local cache for rendering
      for (const block of remoteBlocks) {
        if (block.origin && block.origin !== os.hostname()) {
          // Write to local cache with a remote: prefix
          writeCache(`remote:${block.origin}:${block.source}`, block.data, 30_000);
        }
      }
    }

    consecutiveErrors = 0;
  } catch (e) { ... }
};
```

### Template Block: `<!-- pmd: remote:tree -->`

New block type in the injection engine. The `remote:` prefix resolver fetches a named block source from the peer relay instead of resolving locally.

**File:** `src/core/injection-engine.ts` — add a resolver for sources starting with `remote:`:
```typescript
// Pseudocode for the resolver
if (source.startsWith("remote:")) {
  const [, peerLabel, blockName] = source.split(":");
  // Look up peer by label in peers config
  // Fetch block from peer relay via GET /blocks
  // Return block data
}
```

**block-scope.ts** — add `remote:*` sources as `shared` scope:
```typescript
"remote:tree": "shared",
"remote:git-delta": "shared",
```

---

## 6. Crew Broadcast Across Machines

### Current State

Crew broadcast is **already partially functional.** The relay aggregates sessions via `/crew`, merges by origin, and the `/sync` endpoint exchanges sessions between relays. `crew-render.ts` already renders remote sessions with origin badges (line 135: `remoteTag`).

### What Works

1. **Daemon → Relay:** `POST /crew` pushes local sessions, receives merged remote sessions. ✅
2. **Relay → Relay:** `POST /sync` exchanges all groups every 5s. ✅
3. **Rendering:** `crew-render.ts` shows `· remote: <origin>` badge for remote sessions. ✅
4. **Conflict detection:** `findConflicts()` works across local + remote sessions. ✅ (tested in test-link.ts)

### What Needs Extension

**1. Claim propagation (NEW):**

When Hermes on exoserver claims a file, OpenCode on workstation should see the claim immediately. Currently, claims ride inside `CrewSession.claimedFiles` which syncs every 5s via `/sync`. This works but has 5s latency.

**Enhancement:** Add a "claim event" to the sync payload for sub-5s propagation:

```typescript
// protocol.ts — NEW
export interface ClaimEvent {
  sessionId: string;
  path: string;
  action: "claim" | "release";
  timestamp: number;
}

export interface SyncMessage {
  hostname: string;
  groups: Record<string, CrewSession[]>;
  blocks?: BlockSyncPayload;
  claimEvents?: ClaimEvent[];   // NEW
}
```

The relay forwards claim events to peers immediately (out-of-band from the 5s poll). Peers apply the event to their local session cache. This is **optional for v1** — the 5s poll already propagates claims. Add only if 5s latency proves insufficient.

**2. Remote session freshness:**

`SESSION_EXPIRY_MS` is 15s (3× poll interval). The crew stale timeout (`DEFAULT_STALE_MS`) is 90s. Remote sessions expire at the relay level before the crew system considers them stale. This is correct (relay is transport, crew is application) but means a partition >15s causes remote sessions to disappear from the relay, then reappear on reconnect within 5s.

**No change needed** — this is acceptable behavior. The crew system on each machine retains local sessions during partitions.

**3. Crew broadcast for the Hermes coordinator use case:**

When Hermes registers as coordinator on exoserver (`pmd crew register --role coordinator`), the session is written to `.pipemd/crew/cr_*.json`. The daemon polls this and pushes to the relay. The relay syncs to workstation's relay. Workstation's daemon pulls it. OpenCode sees it in the crew block.

**This flow already works end-to-end** once the relay binding is fixed (§4-B1). No additional crew-specific code is needed for the base case.

### Summary

Crew broadcast across machines is the **least-work** Track B item. The infrastructure exists. Fix the relay binding (B1) and it works. Claim event optimization is a v2 enhancement.

---

## 7. Peer Discovery Protocol (v1: Static Peers)

### Recommendation: Static config (Option B from the plan)

For the 2-machine Empire network, static peer configuration is simpler, more predictable, and eliminates the complexity of UDP broadcast (firewall rules, multicast issues, timing windows).

### Peer Config: `~/.pipemd/link/peers.json`

**Current format (relay.ts:128):**
```json
[
  { "host": "192.168.1.73:9741", "token": "shared-secret" }
]
```

**Proposed format (add port + label):**
```json
[
  {
    "host": "192.168.1.73",
    "port": 9741,
    "token": "shared-secret",
    "label": "workstation"
  }
]
```

This fixes the host parsing bug (B2) and adds human-readable labels for crew rendering and status output.

### New File: `src/core/net/peer-discovery.ts` (~80 LOC)

Responsibilities:
1. Read and validate `peers.json`.
2. Health-check each peer on startup (GET `/health` with 3s timeout).
3. Return validated peer list to the relay.
4. Log unreachable peers at startup (warn, don't fail — peers may come online later).

```typescript
// peer-discovery.ts — interface sketch
import type { PeerConfig } from "./protocol.js";

export interface ValidatedPeer extends PeerConfig {
  reachable: boolean;
  hostname?: string;  // from /health response
  latencyMs?: number;
}

export async function loadAndValidatePeers(): Promise<ValidatedPeer[]> {
  const peers = readPeersFile();
  const validated = await Promise.all(
    peers.map(async (peer) => {
      try {
        const start = Date.now();
        const health = await fetchPeerHealth(peer);
        return { ...peer, reachable: true, hostname: health.hostname, latencyMs: Date.now() - start };
      } catch {
        return { ...peer, reachable: false };
      }
    })
  );
  return validated;
}

function readPeersFile(): PeerConfig[] {
  // Reads ~/.pipemd/link/peers.json
  // Validates: host is non-empty string, port is 1-65535 (default 9741)
  // Returns [] on missing/invalid file
}
```

### daemon-config.ts Changes

`loadConfig()` currently validates `.pipemd/config.yml`. Peer config is machine-level (`~/.pipemd/link/`), not project-level. No change to `daemon-config.ts` is needed — peer discovery is relay-level, not daemon-level.

### CLI: `pmd link <host> --token <token> --label <label>`

The `pmd link` command (in `src/commands/link.ts`) manages `peers.json`. Extend it to write the new format with `port` and `label` fields. The `--label` flag is new.

---

## 8. HTTP Endpoint Extensions

### Current Endpoints

| Method | Path | Auth | State |
|--------|------|------|-------|
| POST | `/crew` | localhost-only | ✅ Works |
| POST | `/sync` | Bearer token | ✅ Works |
| POST | `/blocks` | localhost-only | ✅ Works |
| GET | `/blocks` | localhost-only | ✅ Works |
| GET | `/status` | None | ✅ Works |
| GET | `/health` | None | ✅ Minimal (exists already) |

### Endpoint Changes

#### `GET /health` — Enrich (already exists, extend)

**Current response:**
```json
{ "ok": true, "hostname": "exoserver" }
```

**Proposed response:**
```json
{
  "ok": true,
  "hostname": "exoserver",
  "uptime": 3600,
  "version": "1.2.0",
  "relay": {
    "port": 9741,
    "bind": "0.0.0.0",
    "peers": 1,
    "peersReachable": 1
  },
  "store": {
    "groups": 2,
    "totalSessions": 5,
    "blocks": 47
  }
}
```

**Implementation:** Add a `startTime` module variable set in `startRelay()`. Count groups/sessions/blocks from existing Maps. Read version from `package.json`.

**Auth:** No auth (liveness probe for Hermes health-check cron). Keep minimal — no token leakage.

#### `GET /metrics` — NEW

**Purpose:** Machine-readable metrics for monitoring (Hermes watchdog, future Grafana).

**Response (JSON, not Prometheus format — simpler for the Empire):**
```json
{
  "hostname": "exoserver",
  "timestamp": "2026-06-16T12:00:00Z",
  "uptime_seconds": 3600,
  "crew": {
    "groups": 2,
    "total_sessions": 5,
    "local_sessions": 3,
    "remote_sessions": 2
  },
  "blocks": {
    "stored": 47,
    "ttl_ms": 1800000,
    "max": 1000
  },
  "peers": [
    {
      "host": "192.168.1.73",
      "label": "workstation",
      "last_sync": "2026-06-16T11:59:58Z",
      "latency_ms": 3
    }
  ],
  "sync": {
    "interval_ms": 5000,
    "errors_consecutive": 0
  }
}
```

**Auth:** None for v1 (LAN-only). Add Bearer token if exposed to untrusted networks.

**Implementation:** New `handleMetrics()` function in `relay.ts`, registered in `requestHandler()`.

#### `GET /status` — No change needed

Already returns groups + peers. Sufficient for `pmd link --list`.

### Protocol Changes — `protocol.ts`

```typescript
// NEW interfaces
export interface HealthResponse {
  ok: boolean;
  hostname: string;
  uptime: number;
  version: string;
  relay: { port: number; bind: string; peers: number; peersReachable: number };
  store: { groups: number; totalSessions: number; blocks: number };
}

export interface MetricsResponse {
  hostname: string;
  timestamp: string;
  uptime_seconds: number;
  crew: { groups: number; total_sessions: number; local_sessions: number; remote_sessions: number };
  blocks: { stored: number; ttl_ms: number; max: number };
  peers: Array<{ host: string; label?: string; last_sync: string | null; latency_ms: number | null }>;
  sync: { interval_ms: number; errors_consecutive: number };
}
```

---

## 9. Test File Structure

Three new test files, following the existing `node:test` + `node:assert/strict` pattern used by `test-relay.ts`. Each starts real relay instances on ephemeral ports.

### `tests/test-relay-sync.ts` — Cross-relay sync

**Objective:** Test the `syncWithPeers()` outbound path that has zero coverage today.

**Setup:** Two real relay instances (relay A on port 0, relay B on port 0). Relay A's `peers.json` points to relay B's port.

```
tests/test-relay-sync.ts
├── describe("peer discovery and sync")
│   ├── it("syncs crew sessions from relay A to relay B")
│   │     // Push sessions to A via /crew
│   │     // Wait POLL_INTERVAL_MS + buffer
│   │     // Query B via /status → see A's sessions as remote
│   ├── it("syncs crew sessions bidirectionally")
│   │     // Push to both A and B, wait, verify both see each other's sessions
│   ├── it("anti-echo: relay does not return requester's own sessions")
│   │     // A syncs to B, B's response should NOT include A-originated groups
│   └── it("expired sessions are removed after SESSION_EXPIRY_MS")
│         // Push, wait >15s, verify /status shows 0 remote
│
├── describe("peer config validation")
│   ├── it("reads peers.json with host + port format")
│   │     // Write peers.json with {host, port, token, label}
│   │     // Verify readPeers() returns correct array
│   ├── it("handles missing peers.json gracefully")
│   │     // No file → readPeers() returns []
│   └── it("handles malformed peers.json gracefully")
│         // Invalid JSON → readPeers() returns [], logs debug
│
├── describe("syncWithPeers host parsing")
│   ├── it("parses host without port (defaults to 9741)")
│   │     // peer.host = "192.168.1.73", peer.port = 9741
│   │     // Verify connection target is correct
│   └── it("handles IPv6 addresses")
│         // peer.host = "::1", peer.port = 9741
│
└── describe("network partition resilience")
    ├── it("relay continues operating when peer is unreachable")
    │     // Start A, point to unreachable B
    │     // Verify A's /crew still works, no crash
    └── it("relay reconnects when peer comes back online")
          // Start A, point to stopped B
          // Start B, wait sync interval
          // Verify A picks up B's sessions
```

**Key challenge:** The relay's `syncWithPeers()` uses module-level `readPeers()` which reads from `~/.pipemd/link/peers.json`. Tests must override `HOME` to a temp dir and write peers.json there. The existing `test-relay.ts` already does this pattern (lines 15–16: `process.env.HOME = tmpDir`).

**Note:** `syncWithPeers()` runs on `syncTimer` (every 5s). Tests need to either wait ~6s for the timer, or export `syncWithPeers` for direct invocation. **Recommendation:** export `syncWithPeers` as a named export for testability (it's currently a private function).

### `tests/test-block-federation.ts` — Block sync across relays

**Objective:** Test that blocks resolved on one machine are available on another.

```
tests/test-block-federation.ts
├── describe("block push and fetch (single relay)")
│   ├── it("daemon pushes blocks to relay via /blocks")
│   │     // POST /blocks with 2 blocks → stored: 2
│   ├── it("daemon fetches blocks via GET /blocks")
│   │     // Push, then GET → verify blocks returned
│   ├── it("blocks keyed by origin do not clobber")
│   │     // Push from origin-a, push from origin-b (same group+sha+source)
│   │     // GET → both blocks returned (different origins)
│   └── it("block store TTL expiry")
│         // Push block with old timestamp, run expireBlockStore()
│         // Verify block removed
│
├── describe("block federation across relays")
│   ├── it("blocks pushed to relay A appear on relay B via /sync")
│   │     // Push blocks to A, trigger syncWithPeers()
│   │     // Query B's block store → blocks from A present
│   ├── it("federated blocks include origin tag")
│   │     // Block from A has origin: "hostA" on B
│   ├── it("dedup: identical blocks from same origin are not duplicated")
│   │     // Sync twice, verify block count unchanged
│   └── it("block store respects MAX after federation")
│         // Push >1000 blocks, verify eviction
│
├── describe("daemon-client fetchBlocks integration")
│   ├── it("fetchBlocks retrieves blocks from local relay")
│   │     // Push blocks, call fetchBlocks() → returns array
│   ├── it("fetchBlocks returns empty for non-existent group")
│   │     // fetchBlocks("nope", "sha") → []
│   └── it("fetchBlocks is called in poll loop")
│         // Mock relay, start startRelayClient(), verify fetchBlocks called
│         // (This validates the dead-code fix)
│
└── describe("remote: block resolver")
    ├── it("resolves remote:tree block from peer relay")
    │     // Set up peer relay with blocks
    │     // Call resolver with "remote:tree"
    │     // Verify returns peer's tree data
    └── it("falls back to local when peer unreachable")
          // Point remote: resolver at dead peer
          // Verify returns empty or local fallback
```

### `tests/test-crew-broadcast.ts` — Cross-machine crew visibility

**Objective:** Test that crew sessions registered on one machine are visible on another through the relay mesh.

```
tests/test-crew-broadcast.ts
├── describe("crew session propagation")
│   ├── it("coordinator session on relay A visible on relay B")
│   │     // Push coordinator session to A via /crew
│   │     // Sync A → B
│   │     // Query B via /crew (empty push) → A's coordinator in response
│   ├── it("worker sessions propagate with coordinator linkage")
│   │     // Push coordinator + worker to A
│   │     // Sync → B sees both, worker.coordinatorId matches coordinator.id
│   ├── it("sessions from multiple origins coexist")
│   │     // Push from hostA, hostB, hostC to same group
│   │     // Verify all three origins in store
│   └── it("group isolation: sessions in group X don't leak to group Y")
│         // Push to group "pipemd" and group "api"
│         // Query /crew for "pipemd" → only pipemd sessions
│
├── describe("crew claim propagation")
│   ├── it("file claims propagate across machines")
│   │     // Session with claimedFiles on A
│   │     // Sync → B receives session with claims intact
│   ├── it("cross-machine conflict detected")
│   │     // Session on A claims src/auth.ts
│   │     // Session on B claims src/auth.ts
│   │     // findConflicts() on B's merged set → conflict detected
│   └── it("claim release propagates")
│         // Session claims file, syncs to B
│         // Session releases file (new session without claim), syncs
│         // B no longer sees the claim
│
├── describe("crew rendering with remote sessions")
│   ├── it("renderCrewBlock shows remote origin badge")
│   │     // Set remote sessions with _origin
│   │     // renderCrewBlock() → output contains "remote: <origin>"
│   └── it("remote sessions have _remote flag set")
│         // Verify CrewSession._remote === true for relay-returned sessions
│
└── describe("expiry and partition")
    ├── it("remote sessions expire after SESSION_EXPIRY_MS")
    │     // Push to relay, wait >15s without re-push
    │     // /crew response no longer includes expired sessions
    └── it("re-sync after partition restores sessions")
          // Push, sync, partition (stop peer), wait, restart peer, sync
          // Sessions visible again
```

### Test Infrastructure Notes

1. **Mock relay helper** (`tests/helpers/mock-relay.ts`) already exists and is well-built. Use it for daemon-client tests where you need a controlled relay response.

2. **For cross-relay tests**, start TWO real relay instances:
   ```typescript
   const relayA = await startRelay(0);  // ephemeral port
   const relayB = await startRelay(0);
   // Write relayA's port into relayB's peers.json (in temp HOME)
   ```

3. **Export `syncWithPeers`** from `relay.ts` so tests can trigger sync immediately instead of waiting 5s:
   ```typescript
   export function syncWithPeers();  // change from private to exported
   ```

4. **Timer control:** Consider making `POLL_INTERVAL_MS` overridable in tests (env var or parameter) to avoid 5s waits. The protocol constant is `5_000`; tests can set a `PMD_TEST_POLL_MS=50` override.

---

## 10. UFW / Security Considerations

### Empire Network Topology

```
Router (Freebox: 192.168.1.254)
├── exoserver (Dell R730): 192.168.1.72 — Hermes host, PipeMD relay + daemon
└── ivann-Z590-UD-AC (workstation): 192.168.1.73 — OpenCode/Claude, PipeMD relay + daemon
```

Both machines are on a trusted LAN behind the Freebox router. No direct internet exposure of port 9741.

### Port 9741 — Relay HTTP

**UFW rules (both machines):**

```bash
# Allow relay traffic only between Empire machines (not entire LAN)
sudo ufw allow from 192.168.1.72 to any port 9741 proto tcp   # on workstation
sudo ufw allow from 192.168.1.73 to any port 9741 proto tcp   # on exoserver
```

This restricts relay access to the two known machines. The Freebox router does not forward port 9741 from the WAN, so there's no internet exposure.

### Port 9742 — Future UDP Discovery (v2)

Reserved for UDP multicast peer discovery. Not needed for v1 (static peers). If implemented:

```bash
sudo ufw allow from 192.168.1.72 to any port 9742 proto udp   # on workstation
sudo ufw allow from 192.168.1.73 to any port 9742 proto udp   # on exoserver
```

### Endpoint Security Matrix

| Endpoint | Auth | Bind | Risk | Mitigation |
|----------|------|------|------|------------|
| `POST /crew` | localhost-only | 0.0.0.0 | Low — blocked by `isLocalhost()` even on 0.0.0.0 bind | None needed |
| `POST /sync` | Bearer token | 0.0.0.0 | Medium — token is shared secret | UFW restricts to .72/.73; token in `~/.pipemd/link/relay.token` (0600) |
| `POST /blocks` | localhost-only | 0.0.0.0 | Low — blocked by `isLocalhost()` | None needed |
| `GET /blocks` | localhost-only | 0.0.0.0 | Low — blocked by `isLocalhost()` | None needed |
| `GET /status` | None | 0.0.0.0 | Low — reveals group names and peer hosts | UFW restricts to LAN; acceptable for trusted network |
| `GET /health` | None | 0.0.0.0 | Minimal — reveals hostname only | None needed (Hermes health-check requires unauthenticated access) |
| `GET /metrics` | None | 0.0.0.0 | Low-Medium — reveals session counts, peer topology | UFW restricts to .72/.73; add Bearer token if exposed beyond Empire |

### Token Security

The relay token (`~/.pipemd/link/relay.token`) is a shared secret between relays. Security properties:

1. **File permissions:** `0600` (enforced by `enforceFilePermissions()`). ✅
2. **Distribution:** Generated by `pmd link` on the first machine, then passed via `pmd link <host> --token <token>` on the second. The token travels over SSH or in-person. ✅
3. **Storage in peers.json:** The `token` field in `peers.json` is the token for the REMOTE peer's relay (or the local token if shared). `peers.json` should also be `0600`. **Add `enforceFilePermissions()` call after writing peers.json in the CLI.**
4. **Rotation:** Delete `~/.pipemd/link/`, re-run `pmd link` on both machines. `cachedRelayToken` requires restart (see B4).

### Recommendation: No TLS for v1

The Empire LAN is trusted (behind Freebox, UFW-restricted). Plain HTTP for relay traffic is acceptable. TLS adds certificate management complexity for 2 machines.

If the relay is ever exposed to an untrusted network (e.g., remote access over WireGuard to a VPS), add TLS via a reverse proxy (Caddy/nginx) in front of the relay. The relay itself should not implement TLS — it's an internal service.

### SSH Tunnel Fallback (documented, not primary)

The existing `docs/link.md` recommends SSH tunnels for cross-machine. With the 0.0.0.0 bind fix + UFW, SSH tunnels are no longer needed for the Empire. But keep the documentation for users on hostile networks:

```bash
ssh -L 9741:localhost:9741 ivann@192.168.1.72
pmd link localhost:9741 --token <token>
```

---

## 11. Implementation Sequence

Ordered for minimal risk. Each step is independently testable.

### Phase 1: Unfreeze (T4)

| Step | File | Change | Test |
|------|------|--------|------|
| 1.1 | `relay.ts:393` | Change bind from `"127.0.0.1"` to configurable (env `PMD_LINK_BIND`, default `"0.0.0.0"`) | test-relay-sync.ts: verify relay accepts non-localhost connections |
| 1.2 | `relay.ts:186–189` | Fix host parsing in `syncWithPeers()` — use `peer.host` + `peer.port` directly | test-relay-sync.ts: "parses host without port" |
| 1.3 | `protocol.ts` | Add `port` and `label` to `PeerConfig` | — |
| 1.4 | `relay.ts:125–132` | Update `readPeers()` to validate new PeerConfig shape | test-relay-sync.ts: "reads peers.json with host + port format" |
| 1.5 | `relay.ts:167` | Export `syncWithPeers()` for testability | — |
| 1.6 | `relay.ts:373–374` | Enrich `/health` endpoint | test-relay.ts: update /health assertion |
| 1.7 | `relay.ts` | Add `handleMetrics()` + register `/metrics` route | test-relay.ts: add /metrics test |

### Phase 2: Block Federation (T5, gated on T4)

| Step | File | Change | Test |
|------|------|--------|------|
| 2.1 | `relay.ts:27` | Change `BlockKey` to include origin: `${group}:${sha}:${origin}:${source}` | test-block-federation.ts: "blocks keyed by origin do not clobber" |
| 2.2 | `relay.ts:310–334` | `handleBlocksPush` — store origin from `msg.hostname` | test-block-federation.ts |
| 2.3 | `relay.ts:336–360` | `handleBlocksFetch` — return blocks from all origins for (group, sha) | test-block-federation.ts |
| 2.4 | `relay.ts:167–223` | `syncWithPeers()` — include block payload in `/sync` POST | test-block-federation.ts: "blocks appear on relay B" |
| 2.5 | `relay.ts:250–287` | `handleSync` — merge received blocks into block store | test-block-federation.ts |
| 2.6 | `daemon-client.ts:218–233` | Wire `fetchBlocks()` into poll loop | test-block-federation.ts: "fetchBlocks called in poll loop" |
| 2.7 | `protocol.ts` | Add `BlockSyncPayload` to `SyncMessage` | — |
| 2.8 | `injection-engine.ts` | Add `remote:` prefix block resolver | test-block-federation.ts: "resolves remote:tree block" |

### Phase 3: Peer Discovery (T4/T5)

| Step | File | Change | Test |
|------|------|--------|------|
| 3.1 | NEW `peer-discovery.ts` | `loadAndValidatePeers()` — read + health-check peers | test-relay-sync.ts: "peer config validation" |
| 3.2 | `commands/link.ts` | Extend `pmd link <host>` to write new PeerConfig format | manual test |

### Phase 4: Crew Broadcast (T5, mostly works already)

| Step | File | Change | Test |
|------|------|--------|------|
| 4.1 | — | No changes needed for base case (relay binding fix enables it) | test-crew-broadcast.ts: "coordinator session visible on relay B" |
| 4.2 | (v2) `protocol.ts` | Add `ClaimEvent` to `SyncMessage` for sub-5s claim propagation | test-crew-broadcast.ts: "claim release propagates" |

### Phase 5: Empire Integration (T7)

| Step | Description |
|------|-------------|
| 5.1 | Deploy relay + daemon on exoserver (192.168.1.72) |
| 5.2 | Deploy relay + daemon on workstation (192.168.1.73) |
| 5.3 | Configure `peers.json` on both machines (cross-referencing each other) |
| 5.4 | Open UFW port 9741 between .72 ↔ .73 |
| 5.5 | Verify: Hermes coordinator on exoserver visible in OpenCode crew block on workstation |
| 5.6 | Verify: context block resolved on exoserver appears in workstation's daemon cache |

---

## Appendix A: File Inventory

### Files to Modify

| File | LOC | Changes |
|------|-----|---------|
| `src/core/net/relay.ts` | 464 | Bind address (B1), host parsing (B2), block key origin (2.1–2.3), sync payload blocks (2.4–2.5), /health enrichment (1.6), /metrics (1.7), export syncWithPeers (1.5) |
| `src/core/net/protocol.ts` | 54 | PeerConfig port+label (1.3), BlockSyncPayload (2.7), HealthResponse + MetricsResponse (§8), BlockEntry origin |
| `src/core/net/daemon-client.ts` | 245 | Wire fetchBlocks into poll loop (2.6) |
| `src/core/injection-engine.ts` | — | remote: prefix resolver (2.8) |
| `src/core/block-scope.ts` | 55 | Add remote:* sources as shared |
| `src/commands/link.ts` | — | Extend CLI for new PeerConfig format |

### Files to Create

| File | Est. LOC | Purpose |
|------|----------|---------|
| `src/core/net/peer-discovery.ts` | ~80 | Peer loading + health validation |
| `tests/test-relay-sync.ts` | ~200 | Cross-relay sync tests |
| `tests/test-block-federation.ts` | ~200 | Block federation tests |
| `tests/test-crew-broadcast.ts` | ~150 | Crew broadcast tests |

### Files Unchanged

| File | Reason |
|------|--------|
| `src/core/daemon.ts` | Already wires relay client correctly via `config.link?.relay` / `PMD_RELAY` |
| `src/core/daemon-config.ts` | Peer config is relay-level, not project-level. No change needed. |
| `src/core/crew.ts` | Remote session infrastructure (`setRemoteSessions`, `_remote`/`_origin` fields) already works |
| `src/core/crew-render.ts` | Already renders remote origin badges (line 135) |

---

## Appendix B: Existing Test Coverage Assessment

| Test File | LOC | What It Covers | Gaps |
|-----------|-----|----------------|------|
| `tests/test-relay.ts` | 329 | Real relay instance. All endpoints: /health, /status, /crew (push, merge, localhost-only), /sync (auth, merge), /blocks (push, fetch, validation, overwrite, SHA isolation), 404 routing | No peer-sync outbound (`syncWithPeers`), no TTL expiry, no cross-relay, no /metrics |
| `tests/test-daemon-client.ts` | 105 | Mock relay. syncWithRelay (success, no-relay, conn-refused), remote session store/clear | No pushBlocks, no fetchBlocks (dead code), no poll loop, no backoff |
| `tests/test-link.ts` | 458 | Mock relay (not real relay.ts). /crew protocol, /health, /status, token auth, conflict detection, group isolation, session integrity | Uses mock servers, not real relay.ts — does NOT exercise actual relay code paths |
| `tests/helpers/mock-relay.ts` | 83 | Reusable mock relay class | Good infrastructure, ready for new tests |

**Total existing test coverage of relay.ts outbound sync path: 0%.**

---

*End of Track B Design Spec. Implementation tasks: T4 (unfreeze relay), T5 (federation + broadcast), gated on this spec.*
