# pmd link — Cross-Machine Crew Federation

PipeMD Link connects daemons across machines and Docker containers so that crew sessions (agent coordination data) are shared in real time. Agents on different machines can see each other, detect file conflicts, and coordinate work.

## Architecture

```
Machine A                                Machine B
┌──────────────────────────────┐         ┌──────────────────────────────┐
│ pmd-linkd (port 9741)        │         │ pmd-linkd (port 9741)        │
│                              │ sync    │                              │
│  Daemon (pipemd) ──POST /crew│◄═══════►│  Daemon (pipemd) ──POST /crew│
│  Daemon (PipeMD) ──POST /crew│  (5s)   │  Docker (api)  ──POST /crew │
└──────────────────────────────┘         └──────────────────────────────┘
```

- **Relay** (`pmd-linkd`): One per machine. Aggregates crew sessions from all local daemons, syncs with remote relays.
- **Daemon client**: Each `pmd _daemon` pushes its local crew sessions to the relay and receives remote sessions.
- **Group**: A named coordination scope. Daemons with the same group name share crew sessions. Default: repo directory basename.

## Quick Start

### Two dev machines

```bash
# Machine A (desktop)
$ pmd link
✔ Token: abc123def456
✔ Relay: desktop:9741

On the other machine, run:
  pmd link desktop:9741 --token abc123def456

# Machine B (laptop)
$ pmd link desktop:9741 --token abc123def456
✔ Connected to desktop:9741
✔ Crew sessions syncing bidirectionally within 5 seconds.
```

### Docker fleet

```yaml
# docker-compose.yml
services:
  relay:
    image: pipemd/pipemd:latest
    command: pmd _linkd
    ports:
      - "9741:9741"

  agent-api:
    build: .
    environment:
      - PMD_RELAY=http://relay:9741
      - PMD_GROUP=api
    depends_on: [relay]

  agent-frontend:
    build: .
    environment:
      - PMD_RELAY=http://relay:9741
      - PMD_GROUP=frontend
    depends_on: [relay]
```

```bash
$ docker compose up -d
$ pmd link --list   # on the host, via the mapped port
```

## CLI Reference

```
pmd link                          Start relay, show invite command
pmd link <host:port>              Connect to a remote relay
pmd link --list                   Show relay status, groups, and peers
pmd link --disconnect <host>      Remove a peer
pmd link --stop                   Stop the relay process
```

| Flag | Description |
|---|---|
| `--token <token>` | Auth token for the remote relay |
| `--list` | Show relay status and connected peers |
| `--disconnect <host>` | Remove a peer connection |
| `--stop` | Stop the relay process |

## Configuration

### Per-project (`.pipemd/config.yml`)

```yaml
link:
  group: "my-project"               # default: repo directory name
  relay: "http://localhost:9741"     # default: auto-discover on localhost
```

### Environment variables (ideal for Docker)

| Variable | Purpose | Default |
|---|---|---|
| `PMD_RELAY` | URL of the local relay | `http://localhost:9741` |
| `PMD_GROUP` | Group name for this daemon | Repo directory basename |

### Machine-level state (`~/.pipemd/link/`)

| File | Purpose |
|---|---|
| `relay.pid` | Relay process ID |
| `relay.port` | Actual port the relay bound to |
| `relay.token` | Shared secret for peer-to-peer auth |
| `peers.json` | List of configured remote peers |

These files are ephemeral and auto-managed. Do not commit them.

## Relay API

The relay exposes four HTTP endpoints:

### `POST /crew` — Daemon push/pull

Daemons push local crew sessions and receive merged remote sessions for their group.

```json
// Request
{ "group": "pipemd", "hostname": "desktop", "sessions": [...] }

// Response
{ "sessions": [...] }
```

No auth required (trusted network: localhost or Docker network).

### `POST /sync` — Relay-to-relay

Relays exchange all groups in a single request.

```json
// Request
{ "hostname": "laptop", "groups": { "pipemd": [...], "frontend": [...] } }

// Response
{ "hostname": "desktop", "groups": { "pipemd": [...], "api": [...] } }
```

Requires `Authorization: Bearer <token>` header.

### `GET /status` — Monitoring

Returns all groups and their agent counts, plus peer connection status.

```json
{
  "ok": true,
  "hostname": "desktop",
  "groups": { "pipemd": { "local": 3, "remote": 2 } },
  "peers": [{ "host": "laptop:9741", "lastSync": "2026-05-23T14:23:01Z" }]
}
```

### `GET /health` — Liveness

```json
{ "ok": true, "hostname": "desktop" }
```

## How It Works

1. Each daemon reads its local `.pipemd/crew/` sessions (existing behavior)
2. Every 5 seconds, the daemon pushes sessions to the relay via `POST /crew`
3. The relay stores sessions in memory, keyed by `(group, hostname)`
4. The relay responds with remote sessions from other hostnames for the same group
5. The daemon merges remote sessions into `listSessions()` — tagged with `_remote: true` and `_origin: <hostname>`
6. `renderCrewBlock()`, `findConflicts()`, and injection resolvers all work unchanged on the merged set
7. Remote relays sync all groups via `POST /sync` every 5 seconds

## Security

| Connection | Auth | Network |
|---|---|---|
| Daemon → Relay | None | Trusted (localhost / Docker network) |
| Relay → Relay | Bearer token | Untrusted (use SSH tunnel) |

For remote connections, use an SSH tunnel:

```bash
ssh -L 9741:localhost:9741 user@remote-machine
pmd link localhost:9741 --token abc123
```

## Failure Modes

| Failure | Behavior |
|---|---|
| Relay crashes | Daemons fall back to local-only crew. No data loss. |
| Relay restarts | Daemons re-populate the relay within 5 seconds |
| Peer disconnects | Remote sessions expire after 15 seconds of missed syncs |
| Network partition | Each side continues operating with local sessions only |

## Use Cases

| Scenario | How |
|---|---|
| Multiple agents on one machine | Relay aggregates all local daemons via groups |
| Desktop + laptop | Two relays sync over SSH or LAN |
| Docker agent fleet | Container daemons connect to relay via Docker DNS |
| Mixed local + Docker | Same relay, localhost + Docker network |
| Monitor-only (no local agents) | `pmd link --list` queries remote relay status |
