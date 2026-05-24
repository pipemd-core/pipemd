# Link Architecture — Internal Reference

This document describes the internal design of the `pmd link` feature for contributors.

## Module Layout

```
src/core/net/
├── protocol.ts       — Shared types, constants (CrewMessage, SyncMessage, PeerConfig)
├── relay.ts          — pmd-linkd server (in-memory store, peer sync, expiry)
└── daemon-client.ts  — Daemon-side HTTP client (push local sessions, pull remote)

src/commands/link.ts  — CLI: pmd link, pmd link --list, pmd link <host>
```

## Data Flow

```
Agent writes session → .pipemd/crew/cr_abc.json (existing)
                         ↓
Daemon reads local sessions → listLocalSessions()
                         ↓
Daemon POST /crew → Relay (localhost:9741)
                         ↓
Relay stores in memory → Map<group, Map<origin, { sessions, lastSeen }>>
                         ↓
Relay responds with → remote sessions for same group (excludes requesting origin)
                         ↓
Daemon stores in memory → remoteSessionsCache in crew.ts
                         ↓
listSessions() returns → local sessions + remote sessions
                         ↓
renderCrewBlock(), findConflicts(), injection resolvers → work on merged set
```

## Relay Session Store

```typescript
// Map<group, Map<origin, { sessions: CrewSession[], lastSeen: number }>>
const store = new Map<string, Map<string, { sessions: CrewSession[]; lastSeen: number }>>();
```

- **group**: The coordination scope name (e.g., "pipemd")
- **origin**: The hostname that pushed the sessions (e.g., "desktop", "laptop")
- **lastSeen**: Timestamp of last push, used for expiry

### Expiry

Sessions not refreshed within 15 seconds (3x poll interval) are evicted. This handles:
- Container crashes (no graceful shutdown)
- Network partitions
- Stale registrations

### Persistence

None. The store is fully in-memory. On relay restart, daemons re-populate within one poll cycle (5 seconds). This simplifies the relay and eliminates disk I/O.

## CrewSession Extensions

The `CrewSession` interface has two optional fields for remote sessions:

```typescript
interface CrewSession {
  // ... existing fields ...
  _remote?: boolean;   // true if this session came from a remote relay
  _origin?: string;    // hostname of the remote machine
}
```

These are added by the daemon client when receiving remote sessions. They flow through the existing rendering and conflict detection code without modification — `findConflicts()` checks `claimedFiles` regardless of origin.

## Configuration Resolution

The daemon resolves relay settings in this priority order:

1. `PMD_RELAY` environment variable (highest — Docker use case)
2. `link.relay` in `.pipemd/config.yml`
3. Auto-discover: check if relay is running on `localhost:9741`
4. No relay → local-only crew (existing behavior, zero overhead)

Group name resolution:

1. `PMD_GROUP` environment variable
2. `link.group` in `.pipemd/config.yml`
3. Default: `path.basename(process.cwd())` (repo directory name)

## Relay Process Lifecycle

```
pmd link → starts _linkd as detached child
         → writes PID to ~/.pipemd/link/relay.pid
         → relay binds port (tries 9741, then 9742, etc.)
         → writes actual port to ~/.pipemd/link/relay.port
         → starts peer sync timer (5s interval)
         → starts expiry timer (15s interval)

SIGTERM/SIGINT → delete PID file, stop server, exit
```

The relay is a hidden command (`_linkd`) like the daemon (`_daemon`). Users interact via `pmd link` which manages the process lifecycle.

## Peer Sync Protocol

Relay-to-relay sync uses `POST /sync`:

```json
{
  "hostname": "laptop",
  "groups": {
    "pipemd": [ /* CrewSession[] */ ],
    "frontend": []
  }
}
```

The response contains all groups from the responding relay, excluding any groups that originated from the requesting relay's hostname. This prevents echo loops.

Auth: `Authorization: Bearer <token>` header. The token is read from `~/.pipemd/link/relay.token`.

## Testing

### Unit tests
- Mock HTTP server for relay endpoints
- Mock HTTP client for daemon client
- Test session store expiry
- Test `listSessions()` merge with remote cache
- Test `findConflicts()` across local + remote

### E2E test (`tests/e2e-link.sh`)
- Start two relays on localhost (ports 9741 and 9742)
- Start two daemons, each connected to a different relay
- Verify crew sessions propagate from daemon A to daemon B
- Verify conflict detection across relays
- Clean up processes

## Adding New Features

The architecture is designed for extension. The relay's star topology and in-memory store provide a foundation for future capabilities, which will be prioritized based on user demand:

- **Block sharing**: Add a `POST /blocks` endpoint to the relay. Daemons push rendered blocks. Remote daemons subscribe via `GET /blocks?group=pipemd`.
- **mDNS discovery**: Zero-config relay discovery on LAN.
- **TLS peer sync**: Encrypted peer-to-peer communication.

> **Note:** These are design notes for future development, not committed roadmap items. See `ROADMAP.md` for current priorities.
