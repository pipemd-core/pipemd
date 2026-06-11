# PipeMD Lexicon

A complete reference for every domain-specific term in the PipeMD codebase.

- Bullet prefix (`-`) marks user-facing concepts — things a PipeMD user would encounter.
- Code-styled terms (`like this`) reference TypeScript types, constants, or source identifiers.

---

## Core Concepts

- **PipeMD** / **pmd** — The tool itself. "Real-time project context for AI coding agents." Invoked as `pmd` on the CLI.

- **context file** — The Markdown file an AI agent reads for project state (e.g., `AGENTS.md`, `CLAUDE.md`). Can be a named pipe or a regular file. See `CONTEXT_FILES`.

- **zero git churn** — PipeMD's design goal: in pipe mode, the context file is a FIFO that never changes on disk, so git never sees modifications.

- **ephemeral** — Output that is never written to disk; exists only in memory or on a FIFO stream.

- **prompt cache / LLM prefix cache** — Optimization strategy: static content at the top of the context file, volatile data at the bottom. The LLM's prefix cache stays warm across refreshes because the static prefix rarely changes.

- **pmd block** — A tagged region in a template: `<!-- pmd: name -->...<!-- /pmd -->`. The daemon replaces the inner content with live script output on every cycle. Read-only — the daemon overwrites it. See `BLOCK_RE`.

- **pmd-context separator** — The marker `<!-- pmd-context -->` that separates `base.md` content (above) from `template.md` content (below) in the composed output. See `PMD_CONTEXT_SEPARATOR`.

- **bidirectional write-back** — Mechanism where AI edits outside `pmd:` blocks persist to `base.md` or `template.md` on disk. The daemon de-renders blocks and writes only the non-block edits back.

- **one-shot render** — Running `pmd run` to render context to stdout or a file without spawning a daemon.

- **self-improving** — Scripts and templates are plain text in `.pipemd/`; the AI can edit its own context harness.

`CONTEXT_FILES` — The array of recognized context file names: `["AGENTS.md", "AI_CONTEXT.md"]`. Defined in `src/core/paths.ts`.

---

## Injection

- **DeliveryMode** — How context reaches the AI. One of:
  - `"passive"` — rendered to pipe/file, no hooks.
  - `"active"` — hooks inject fresh context on every tool call.
  - `"expert"` — full custom rule configuration.

- **InjectionTrigger** — The moments when active injection fires:
  - `"before-read"` — before the agent reads a file.
  - `"before-edit"` — before the agent edits a file.
  - `"after-edit"` — after the agent edits a file (triggers async validation).
  - `"on-idle"` — when the agent session goes idle.
  - `"on-start"` — when the agent session starts.

- **ContextSource** — A named data source for injection content. Examples: `git-delta`, `git-status`, `lint`, `type-check`, `crew-status`, `file-errors`, `test-failures`, `dead-code`, `now`. The canonical list is `BLOCK_SOURCES` in `src/core/block-scope.ts`.

- **InjectionScope** — Whether a rule's content is scoped to the file being edited or applies project-wide:
  - `"target-file"` — content is about the specific file the agent is interacting with.
  - `"global"` — content applies to the whole project.

`InjectionRule` — A single injection rule: `{ source, scope, max-lines?, async?, command?, label?, interval-min? }`.

`InjectionConfig` — Top-level injection config: `{ delivery, rules, customCommandsAllowed? }`. Stored in `.pipemd/injection.yml`.

`InjectionPayload` — A resolved piece of injection content ready for delivery: `{ trigger, source, scope, targetFile?, content, hash }`.

- **injection.yml** — User-edited YAML file in `.pipemd/` defining injection rules for active/expert mode.

- **pmd inject** — CLI command that harness hooks call: `pmd inject --trigger <trigger> --file <path>`. Runs the injection engine for one trigger event.

`DEFAULT_ACTIVE_RULES` — The built-in default rule set used when delivery is `"active"` and no user rules are specified.

`InjectionEngine` — The rules engine (`src/core/injection-engine.ts`) that, given a trigger + context, resolves matching rules, runs source resolvers, applies dedup/truncation, and emits payloads.

`SourceResolver` — A function `(ResolverContext) => Promise<string>`. Each `ContextSource` has one registered in the engine.

`ResolverContext` — Interface passed to each source resolver: `{ trigger, targetFile?, sessionId?, config, intervalMin? }`.

`RATE_LIMIT_WINDOW_MS` / `MAX_INJECTIONS_PER_WINDOW` — Safety valves: 30 injections per 10-second window per session.

`RESOLVER_TOTAL_BUDGET_MS` — 5000ms total budget for all resolvers in a single injection call.

`VALIDATION_COOLDOWN_MS` — 60s cooldown between async validation runs (after-edit lint/type-check).

`computePayloadHash` — SHA-256 hash (first 16 hex chars) of injection content, used for dedup.

`parseCommand` — Splits a command string into `{ bin, args, env }`, extracting leading `KEY=VALUE` env assignments.

`buildBlock` — Wraps script output into `<!-- pmd: name -->\n```\n...\n```\n<!-- /pmd -->`.

`BLOCK_RE` — Regex matching `<!-- pmd: name -->...<!-- /pmd -->` blocks in template/rendered content.

`renderContentAsync` — Async render: parses template tags, runs all commands concurrently via `Promise.allSettled`, replaces tags with output.

`reverseInject` — De-renders a composed document back to the template: replaces pmd blocks with their template placeholders, preserving user edits. Used by write-back.

---

## Block Scope

`BlockScope` — Enum: `"shared"` or `"local"`. Determines whether a rendered block is identical for all sessions or scoped per-session.

`BLOCK_SOURCES` — The canonical list of all valid source identifiers. Defined in `src/core/block-scope.ts`.

- **shared block** — A block whose content is identical for all sessions (e.g., `git-delta`, `test-failures`, `dead-code`, `now`). Safe to render once and reuse.

- **local block** — A block whose content is session-specific (e.g., `crew-locks`, `file-errors`, `import-graph`, `session-diff`). Must be rendered per-session.

`getBlockScope` / `isSharedBlock` — Functions to query a source's scope classification.

---

## Crew

- **Crew** — The multi-agent coordination system. Gives agents shared awareness of file claims, conflict detection, and status broadcasts.

- **CrewRole** — `"coordinator"` (manages sub-agents) or `"worker"` (claims specific files, reports to coordinator).

`CrewSession` — A registered agent's record: `{ schema, id, role, harness, label?, pid, ppid, coordinatorId, claimedFiles, note?, startedAt, lastHeartbeat, cwd }`.

`CrewClaim` — A file claim: `{ path, claimedAt, note? }`.

- **session ID** — A unique identifier for a crew session, prefixed `cr_` + 12 hex chars (e.g., `cr_d94da882209e`).

`CREW_SCHEMA` — Version number for the session file format (currently `1`).

- **heartbeat** — Periodic update to `lastHeartbeat` timestamp on a session file. Sessions without a heartbeat for `DEFAULT_STALE_MS` are considered stale.

`DEFAULT_STALE_MS` — 90,000ms (90 seconds). Stale session threshold.

`PID_GRACE_MS` — 15,000ms. Grace period for PID-based alive checks.

- **stale session** — A session whose heartbeat is older than `DEFAULT_STALE_MS`. Automatically reaped by the daemon.

- **coordinator** — The top-level agent session in a harness. Workers are spawned by a coordinator.

- **worker** — A sub-agent spawned by a coordinator. Claims specific files, reports to coordinator.

- **conflict** — When two or more sessions claim the same file. Rendered as `⚠️ CONFLICT` in the crew block.

- **passive agent** — An agent running without a crew session (no hooks installed). Its edits are uncoordinated.

- **crew ledger** — The per-agent coordination files stored in `.pipemd/crew/` (one JSON file per session).

`reapStaleSessions` — Daemon function that deletes session files whose PID is dead and heartbeat is stale.

`writeSessionAtomic` — Writes a session JSON file using `atomicWrite` (O_EXCL + rename).

`CrewMessage` — Network message type for pushing crew sessions to a relay: `{ group, hostname, sessions, commitSha? }`.

---

## Pipes & FIFOs

- **named pipe / FIFO** — A Unix `mkfifo` special file. PipeMD creates one for each context file; when an agent reads it, PipeMD intercepts the read and streams live content.

`PipeMode` — `"pipe"` (FIFO) or `"legacy"` (regular file).

`PipeConfig` — The full `.pipemd/config.yml` schema: `{ version, output?, delivery?, base?, commands, commandTimeouts?, injected, pipes, link?, settings }`.

- **mkfifo** — The Unix command used to create named pipes. `checkMkfifo` verifies it is available.

- **EPIPE** — Error code when writing to a pipe whose reader has closed. PipeMD catches this gracefully.

- **ENXIO** — Error code "No such device or address" — occurs when opening a FIFO for write and no reader is present. PipeMD retries up to `ENXIO_MAX_RETRIES` within `ENXIO_RETRY_WINDOW_MS`.

`ENXIO_MAX_RETRIES` — 100 retries.

`ENXIO_RETRY_WINDOW_MS` — 60,000ms (60 seconds).

- **re-serve / reServeDelayMs** — After a reader disconnects, the daemon waits `DEFAULT_RESERVE_DELAY_MS` (default 1000ms) then re-opens the pipe for the next reader.

`writeSafe` — Writes to a pipe fd, catching EPIPE errors and returning false instead of throwing.

`closeSafe` — Closes a pipe fd, catching errors.

`serveContextPipe` — The main pipe-serving loop: opens the FIFO for write (blocking until a reader connects), renders content, streams it, then re-serves.

`serveCommandPipe` — Serves a pipe bound to a single command (not a full template render).

`resolvePipePath` — Determines the filesystem path for a pipe entry. If it has a `render` field, it's a context file in the project root; otherwise it goes in `LIVE_DIR`.

`createPipe` — Creates a named pipe at a given path using `mkfifo`, with permissions `0o600`.

`shutdownPipes` — Cleanup function that removes FIFOs and tracked timers on daemon stop.

`trackedSetTimeout` / `trackedSetInterval` — Timer wrappers that track all active timers so they can be cleaned up on shutdown.

`COMMAND_TIMEOUT_MS` — 10,000ms. Default timeout for script execution per block.

`DEFAULT_RESERVE_DELAY_MS` — 1000ms. Default delay between re-serves.

- **legacy mode** — Fallback using file watchers (`chokidar`) + regular file writes instead of FIFOs. Used on native Windows or when FIFO reads fail. See `legacy-watcher`.

---

## Hooks & Harnesses

- **Harness** — An AI coding agent tool (e.g., Claude Code, OpenCode, Cursor, Aider, Gemini). Each has different hook mechanisms.

`HarnessName` — Type union: `"OpenCode"` | `"Claude Code"` | `"Cursor"` | `"Aider"` | `"Gemini"` | `"OpenClaw"` | `"Hermes"` | `"OS Agent"`.

`HarnessDetection` — Result of auto-detecting which harnesses are present: `{ name, targetFile, detected, signals, needsLegacyMode }`.

`HARNESS_TARGETS` — Map from harness name to the context file it reads (e.g., Claude Code → `CLAUDE.md`, Gemini → `AI_CONTEXT.md`).

`HarnessAdapter` — Interface for harness-specific hook installers: `{ name, installHooks(cwd, delivery, dryRun, force), removeHooks(cwd) }`.

`HookInstallResult` — Result of installing/removing hooks: `{ harness, installed, mechanism, detail, injectionMode? }`.

- **mechanism** — The installation method: `"hook"` (native hooks), `"instruction"` (passive rendering, no hook API), `"unknown"`, `"error"`, `"none"`.

`INSTRUCTION_ONLY` — Harnesses that lack edit-event APIs (Cursor, Aider, OpenClaw, Hermes, OS Agent) — they use passive/instruction mode only.

`HookEntry` — A single hook entry: `{ event, matcher?, command, timeout?, category, injectOnly? }`.

`JsonHooksOpts` — Options for JSON-based hook installation: `{ file, harness, mechanism, hooks, delivery, dryRun, statusline?, settingsDir }`.

- **dryRun** — Flag to simulate hook installation without writing files.

- **force** — Flag to overwrite existing hooks even if they are present.

`claude-hooks` — Module for Claude Code-specific hook installation (PreToolUse, PostToolUse JSON hooks).

`opencode-hooks` — Module for OpenCode-specific hook installation.

`gemini-hooks` — Module for Gemini CLI-specific hook installation.

`hook-utils` — Shared utilities for JSON-based harness hook installation (`readJsonSettings`, `writeJsonSettings`, `stripPmdHooksFromSettings`, `installJsonHooks`).

---

## Caching

`CacheEntry` — A single cached render result: `{ key, data, hash, timestamp, ttl, metadata? }`.

`CACHE_DIR` — Path `.pipemd/cache/sources`. Stores rendered source outputs.

`VALIDATION_DIR` — Path `.pipemd/cache/validation`. Stores async validation results (lint/type-check).

`DEFAULT_TTLS` — Per-source TTL defaults in ms:

| Source | TTL |
|--------|-----|
| `crew` | 5s |
| `lint`, `type-check` | 30s |
| `git-status`, `git-delta` | 10s |
| `validation` | 60s |
| `tree`, `deps` | 120s |
| `arch` | 300s |
| `todos`, `test-failures` | 60s |
| `syntax-check` | 10s |
| `edit-diff` | 5s |

- **TTL** (Time-To-Live) — The freshness window for a cache entry. If `Date.now() - entry.timestamp > entry.ttl`, the entry is expired.

- **fresh** — A cache entry that has not exceeded its TTL. `isFresh(key)` returns true.

- **stale** — A cache entry that has exceeded its TTL. `readCache` returns null for stale entries.

`TtlCache<T>` — Generic in-memory cache with a TTL. `get()` returns value if fresh, null if stale.

`readCache` / `writeCache` — Reads/writes a cache entry by key.

`invalidate` / `invalidateCachePattern` — Deletes cache entries by exact key or filename pattern.

`ensureCacheDir` — Creates cache directories if they don't exist.

---

## Deduplication

- **dedup** (injection dedup) — Per-session deduplication: skips injecting content that has not changed since the last injection. Saves LLM tokens.

`SessionStore` — Maps source name to last-injected hash for a session: `Record<string, { hash, timestamp }>`.

`INJECTED_DIR` — Path `.pipemd/cache/injected`. One JSON file per session storing its `SessionStore`.

- **hash** — SHA-256 truncated to 16 hex chars of injection content. Used to compare current vs. previously injected content.

`recordInjection` — Saves a source's hash and timestamp to the session store.

`checkInjectionStatus` — Returns `"new"` (never injected), `"changed"` (different hash), or `"unchanged"` (same hash).

`purgeOldRecords` — Garbage-collects dedup files older than `maxAgeMs` (default 1 hour).

`memCache` — In-memory LRU cache of `SessionStore` objects (TTL 2s, max 128 entries) to avoid disk reads on every injection.

---

## Daemon

- **daemon** — The background process (`pmd start`) that creates pipes, serves context on read, runs the injection engine, reaps stale sessions, and manages write-back.

`PID_FILE` — `.pipemd/.daemon.pid`. Contains the daemon's process ID.

`STATUS_FILE` — `.pipemd/.status.json`. Contains daemon health: last run time, duration, rendered bytes.

`INJECTION_LOG_DIR` — `.pipemd/.injection-log`. Per-injection event logs.

`INJECT_STATS_FILE` — `.pipemd/.inject-stats.json`. Aggregate injection stats (delivered count, dedup count, last event).

`TUI_STATS_FILE` — `.pipemd/.tui-stats.json`. Stats for the OpenCode TUI panel.

`INJECTION_LOG_MAX_AGE_MS` — 3,600,000ms (1 hour). Injection log entries older than this are cleaned up.

- **stale PID recovery** — On `pmd start`, if `PID_FILE` exists but the process is dead, old pipes are cleaned up and the daemon starts fresh.

`resolveExternalTools` — Resolves optional external tools (e.g., `@ast-grep/cli` binary → `PMD_ASTGREP` env var). Called at daemon startup.

`PMD_ASTGREP` — Environment variable set by the daemon containing the resolved path to the `ast-grep` binary. Propagated to all spawned scripts.

---

## Init & Config

- **Ecosystem** — Auto-detected project type: `"Node/TypeScript"` | `"Python"` | `"C-CPP"` | `"Rust"` | `"Go"` | `"DevOps"` | `"Generic"`.

- **AiAgent** — The AI agent the user selects during init: `"Claude Code"` | `"Cursor"` | `"Aider"` | `"Gemini"` | `"Generic"` | `"OpenClaw"` | `"Hermes"`.

- **TokenProfile** — Controls how much output each block produces: `"low"` (~3K tokens) | `"medium"` (~6K) | `"high"` (~12K) | `"xhigh"` (~22K) | `"unlimited"`.

`ScriptDef` — Defines a single context-gathering script: `{ id, label, description, command, category, volatile, file }`.

`RunResult` — Result of test-running a script: `{ id, status: "success"|"error"|"empty"|"timeout", stdout, stderr, lines }`.

`SCRIPT_LIBRARY` — The complete library of available scripts, organized by category (architecture, project, git, quality, db, api, frontend, cpp, rust, go, devops).

`SCRIPT_MAX_LINES` — Per-script line limits (e.g., arch=100, tree=50, lint=20). Scaled by token profile.

`SCRIPT_COMPANIONS` — Map of script IDs to companion files they depend on (e.g., dead-code depends on `run-knip.sh` and `format-knip.mjs`).

- **volatile** — A volatility rating (1–5) for scripts. Higher = more frequently changing output. Used to position blocks in the template (volatile data at bottom to preserve prompt cache).

- **category** — Script classification: `"project"` | `"git"` | `"quality"` | `"db"` | `"api"` | `"frontend"` | `"cpp"` | `"rust"` | `"go"` | `"devops"` | `"architecture"`.

`ECOSYSTEM_DIR_MAP` — Maps ecosystem names to their script directory names.

`contextFileName` — Function mapping an `AiAgent` to its context file name (e.g., Claude Code → `CLAUDE.md`, Cursor → `.cursorrules`).

`HARNESS_CLI` — Map of harness names to their CLI binary names.

`estimateTokens` — Estimates LLM tokens for a script (lines × tokens-per-line × profile multiplier).

`PmdMode` — `"agent"` (daemon serving an agent) or `"file"` (one-shot file output).

- **debounceMs** — Config setting: delay before re-rendering after a template change (legacy mode).

---

## Networking & Federation

- **relay** (`pmd link`) — A lightweight HTTP server that syncs crew sessions between machines. Runs on port 9741.

- **peer** — A remote relay connected to the local relay. Peers sync crew sessions via the `/sync` endpoint.

- **group** — A named scope for crew session routing across machines. Default: repo directory name.

- **bearer token** — Auto-generated token required for relay-to-relay `/sync` endpoint authentication.

- **localhost-only** — The `/crew` endpoint only accepts connections from loopback addresses.

`DEFAULT_PORT` — 9741. Default relay listen port.

`POLL_INTERVAL_MS` — 5,000ms. How often the daemon polls its local relay.

`SESSION_EXPIRY_MS` — 15,000ms. Relays expire session data if not refreshed within this window.

`CrewMessage` — Network message: `{ group, hostname, sessions, commitSha? }`.

`SyncMessage` — Inter-relay sync message: `{ hostname, groups: Record<string, CrewSession[]> }`.

`PeerConfig` — Peer connection config: `{ host, token }`.

`RelayStatus` — Relay status response: `{ ok, hostname, groups, peers }`.

`BlockPushMessage` — For pushing rendered block data to a relay: `{ group, hostname, commitSha, blocks }`.

`BlockEntry` — A rendered block shared via federation: `{ source, data, timestamp, hash }`.

`PMD_RELAY` — Environment variable for the relay URL (e.g., `http://host.docker.internal:9741`).

`PMD_GROUP` — Environment variable for the federation group name.

`PMD_LINK_PORT` — Environment variable to override the relay listen port.

---

## Tracing

- **pmd trace** — CLI command: live TUI showing session tree, file locks, and injection timeline. Flags: `--locks`, `--timeline`, `--snapshot`.

`TraceSession` — A crew session enriched with trace data: `{ ..., alive, staleMs, dedupSources, injectionCount, dedupCount, lastEvent?, children }`.

`TraceEvent` — A single injection event: `{ ts, trigger, tool, file, result, tokens, sessionId?, payload? }`.

`TracePayload` — A recorded injection payload for timeline display: `{ id, timestamp, content, meta? }`.

`TraceConflict` — A file claimed by multiple sessions: `{ path, sessionIds, sessions }`.

`TraceData` — Aggregated trace data for the current project: sessions, events, payloads, conflicts.

`LockEntry` — A file lock resolved from trace data: path + list of sessions claiming it.

---

## Statusline & Stats

`InjectEvent` — A single injection event: `{ trigger, file, result: "delivered"|"dedup", ts }`.

`InjectStats` — Aggregate injection statistics: `{ delivered, dedup, lastEvent? }`.

- **delivered** — An injection that produced new or changed content (not deduplicated).

- **dedup** (stat) — An injection that was skipped because content was unchanged since last delivery.

`estimateTokens` (stats) — Rough token estimate: bytes ÷ 4.

`formatTokenCount` — Formats a token count for display (e.g., 1500 → `"1.5k"`).

`findContextBytes` — Measures the current rendered context size in bytes.

`GEMINI_STATUSLINE_STATE` — `.pipemd/.statusline-gemini.json`. Gemini-specific statusline state.

`CREW_STATUS_FILE` — `.pipemd/.crew-status.json`.

---

## Filesystem Paths

All paths are relative to the project root. Defined in `src/core/paths.ts`.

| Constant | Path | Purpose |
|----------|------|---------|
| `PIPEMD_DIR` | `.pipemd` | Root of all PipeMD state |
| `LIVE_DIR` | `.pipemd/live` | Ephemeral named pipes (gitignored) |
| `PID_FILE` | `.pipemd/.daemon.pid` | Daemon process ID |
| `STATUS_FILE` | `.pipemd/.status.json` | Daemon health status |
| `CONFIG_PATH` | `.pipemd/config.yml` | Main configuration file |
| `INJECTION_LOG_DIR` | `.pipemd/.injection-log` | Per-injection event logs |
| `INJECT_STATS_FILE` | `.pipemd/.inject-stats.json` | Aggregate injection stats |
| `TUI_STATS_FILE` | `.pipemd/.tui-stats.json` | TUI panel stats |
| `CREW_DIR` | `.pipemd/crew` | Per-agent coordination JSON files (gitignored) |
| `SCRIPTS_DIR` | `.pipemd/scripts` | Data-gathering scripts (committed) |
| `TEMPLATE_PATH` | `.pipemd/template.md` | Template with pmd: tags (committed) |
| `PIPES_DIR` | `.pipemd/pipes` | Pipe configuration directory |
| `BASE_PATH` | `.pipemd/base.md` | Custom AI instructions prepended to context (committed) |
| `BAK_PATH` | `.pipemd/context.bak` | Backup of original context file during init |
| `CONTEXT_FILES` | `["AGENTS.md", "AI_CONTEXT.md"]` | Recognized context file names |

`atomicWrite` — Writes files atomically using O_EXCL + rename. Prevents partial writes.

---

## Write-Back

`loadBase` — Reads `.pipemd/base.md` content.

`composeContent` — Concatenates base content + rendered template, separated by `<!-- pmd-context -->`.

`splitContextContent` — Inverse of `composeContent` — splits a composed document at `<!-- pmd-context -->` back into base and template portions.

`handleIncomingWrite` — Handles a write from the AI to the context file. De-renders pmd blocks, persists non-block edits to `base.md`/`template.md`.

`writeBackInProgress` — Guard flag preventing concurrent write-back operations.

---

## Process Utilities

`isPidAlive` — Checks if a process with a given PID is still running. Used for stale session detection.

`UserError` — Custom error class for CLI-facing errors with user-friendly messages.

`log` / `logger` — File logger writing to `.pipemd/daemon.log`.

`detectProject` — Auto-detects the project ecosystem by scanning for marker files (`package.json`, `requirements.txt`, `Cargo.toml`, etc.).

`detectHarness` — Auto-detects which AI harnesses are present by checking for config files and running processes.

- **HEADLESS mode** — Non-interactive init for CI/CD (`pmd init --headless`). Accepts all defaults.

- **Promise.allSettled** — Pattern used for isolated rendering: a failing script renders an error in-place; the rest of the document loads fine.

---

## CLI Commands

| Command | Purpose |
|---------|---------|
| `pmd init` | Interactive setup: detect ecosystem, select scripts, configure harness |
| `pmd start` | Start the daemon |
| `pmd stop` | Stop the daemon |
| `pmd restart` | Restart the daemon |
| `pmd status` | Show daemon status |
| `pmd run` | One-shot render to stdout or file |
| `pmd inject` | Run injection engine (called by hooks) |
| `pmd refresh` | Re-render context immediately |
| `pmd validate` | Validate configuration and scripts |
| `pmd doctor` | Diagnose common setup issues |
| `pmd link` | Start or configure the federation relay |
| `pmd crew` | Manage crew sessions (join, leave, claim, status) |
| `pmd trace` | Live TUI showing session tree, locks, and timeline |
| `pmd statusline` | Output statusline data for agent TUI panels |
| `pmd uninstall` | Remove all hooks and PipeMD state |

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `PMD_SESSION` | Crew session ID propagated to child processes |
| `PMD_ASTGREP` | Resolved path to ast-grep binary (set by daemon) |
| `PMD_KNIP` | Override path to knip binary |
| `PMD_RELAY` | Relay URL for federation |
| `PMD_GROUP` | Federation group name |
| `PMD_LINK_PORT` | Override relay listen port |
