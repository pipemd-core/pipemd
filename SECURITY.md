# Security Model

PipeMD executes shell commands, manages named pipes, and communicates over HTTP. This document describes the threat model, attack surfaces, and mitigations.

## Trust Boundaries

| Boundary | Trusted? | Notes |
|----------|----------|-------|
| `.pipemd/config.yml` | **Yes** | Defines shell commands that PipeMD executes. Treated as code. |
| `.pipemd/injection.yml` | **Yes** | Defines injection rules and may enable arbitrary command execution via `custom` source. |
| `.pipemd/scripts/` | **Yes** | Shell scripts executed on every context render. |
| `AGENTS.md` (named pipe) | **No** | AI agents write to this pipe. Content is sanitized before write-back. |
| `.pipemd/base.md` | **Partial** | AI edits persist here. Content is user-editable by design. |
| `.pipemd/template.md` | **Partial** | AI edits outside `<!-- pmd: -->` blocks persist here via write-back. |
| Link relay HTTP endpoints | **No** | Network-facing. See Relay Security below. |
| Environment variables | **Partial** | `PMD_RELAY`, `PMD_GROUP`, `PMD_SESSION` are trusted. `PMD_DEBUG` is safe. |

## Attack Surfaces

### 1. Command Execution via Config

**Severity: Critical (by design)**

PipeMD executes commands defined in `.pipemd/config.yml` on every context render. If a malicious `config.yml` is committed to a repository, anyone who runs `pmd start` in that repo executes those commands.

**Mitigations:**
- PipeMD does not auto-start. The user must explicitly run `pmd start` or `pmd init`.
- `pmd init` shows every command it will configure and requires confirmation.
- Commands run with the user's normal permissions — no elevation.

**Recommendation:** Audit `.pipemd/config.yml` and `.pipemd/scripts/` when cloning an unfamiliar repository, just as you would audit `package.json` scripts or `Makefile` targets.

### 2. Custom Command Injection

**Severity: High**

The `custom` injection source in `.pipemd/injection.yml` can execute arbitrary shell commands via `execSync`. This is gated by `customCommandsAllowed: true`.

**Mitigations:**
- The flag defaults to `false`. Users must explicitly enable it.
- When blocked, a warning is logged with the blocked command.
- Commands run with a 5-second timeout.

**Recommendation:** Never commit `customCommandsAllowed: true` with a `command` field to a shared repository. If you need custom commands, use `.gitignore` to exclude `injection.yml` or keep it local.

### 3. Named Pipe Permissions

**Severity: Low**

Named pipes are created with `0o600` (owner read/write only). On shared machines, other users cannot read or write to the pipe.

**Mitigation:** `fs.chmodSync(pipePath, 0o600)` is called immediately after `mkfifo`.

### 4. AI Agent Write-Back

**Severity: Low**

AI agents can write content through the named pipe that gets persisted to `base.md` and `template.md`. The write-back mechanism:
- Strips all `<!-- pmd: -->` blocks before writing (prevents template corruption)
- Uses atomic writes (tmp + rename) to prevent corruption on crash
- Guards against re-entrant writes with a `writeBackInProgress` flag

**Risk:** A misbehaving AI could write arbitrary content to `base.md`. This is by design — `base.md` is the user's editable section.

### 5. Path Traversal

**Severity: Mitigated**

The `pmd inject --file` command validates that the resolved file path is within the project root:
```ts
if (!realPath.startsWith(realCwd + path.sep))
```

This prevents injection commands from reading files outside the project.

### 6. Crew Session Files

**Severity: Low**

Crew sessions are stored as JSON files in `.pipemd/crew/` with no authentication. Any local process can read, write, or delete session files.

**Mitigations:**
- The `.pipemd/` directory should not be world-readable (`chmod 0o700`).
- Session IDs have 48 bits of entropy (sufficient for local filesystem).
- Stale sessions are reaped after 90 seconds.

### 7. Symlink Traversal

**Severity: Mitigated**

Scripts that traverse the filesystem (tree, architecture) follow symlinks only within the project root. The `limit-core.sh` script excludes `.pipemd/` from tree output.

## Relay Security (Link Feature — Beta)

The `pmd link` feature introduces network communication. The security model is **trusted network only**.

### Endpoints

| Endpoint | Auth | Access | Notes |
|----------|------|--------|-------|
| `POST /crew` | None | Localhost only | Daemon pushes local sessions to relay |
| `POST /sync` | Bearer token | Any source | Relays exchange merged session data |
| `GET /status` | None | Any source | Read-only: sessions, peers, groups |
| `GET /health` | None | Any source | Read-only: uptime, group count |

### Threats

| Threat | Severity | Mitigation |
|--------|----------|------------|
| Unauthenticated session injection via `/crew` | Medium | localhost-only check (rejects non-loopback) |
| Token theft from `~/.pipemd/link/relay.token` | Medium | Token file should be `chmod 0o600` (not currently enforced) |
| Plain-text HTTP traffic sniffing | Medium | Use SSH tunnels for remote connections |
| Relay DDoS via session flood | Low | Sessions expire after 15 seconds; no persistence |
| Malicious relay URL in config | Low | `PMD_RELAY` and config are trusted inputs |

### Recommendations for Production Use

1. **Always use SSH tunnels or WireGuard** for cross-machine relay communication. Plain HTTP exposes bearer tokens.
2. **Set `chmod 0o600`** on `~/.pipemd/link/relay.token` after first run.
3. **Firewall the relay port** (default 9741) to only accept connections from expected peers.
4. **Do not expose the relay to the public internet.**

## Reporting Security Issues

If you discover a security vulnerability in PipeMD, please open a GitHub Issue with the tag `security`. For sensitive vulnerabilities, email the maintainer directly (see `package.json`).

## Changelog

| Date | Change |
|------|--------|
| 2026-05-24 | Initial security model document |
