# Changelog 

All notable changes to PipeMD.

## [Unreleased]

### Added — ML Research Closure & Topology Filter
- **Topology filter shipped in the active-mode baseline** — V7's 15× label-spread signal as a deterministic file-type gate. Skips `syntax-check` for non-typeable files, `file-errors` for non-lintable, `import-graph`/`exports` for non-JS/TS. V15 prospective A/B measured −30% input tokens at equal quality. Zero ML in the loop.
- **Rewrite tracker (dormant)** — Session-scoped per-file edit counter. Infrastructure for future rewrite-aware policies; no consumer wired (the V15 adaptive boost was prospectively disproved).
- **15-version ML research closed** — V1–V15 investigated ML-driven context injection. Verdict: injection helps on average (~−29s/step), "always inject within budget" is the best-supported policy (confirmed prospectively), ML-based per-context selection has not earned its place. Full findings in `docs/ml-lessons-for-main.md`.

### Added — Adapter Parity
- **All three adapters now cover 5/5 injection triggers** (before-read, before-edit, after-edit, on-idle, on-start). Previously: Claude 4/5, Gemini 3/5.
- **Claude on-start inject hook** — fires `pmd inject --trigger on-start` at SessionStart.
- **Gemini on-start + on-idle inject hooks** — were missing entirely.
- **Gemini `--invalidate` after edit** — cache was staying stale after edits.
- **Gemini crew join on SessionStart** — sessions now formally register.

### Added — Versioning & Visibility
- **`pmd status` shows the running version** alongside daemon PID.
- **`pmd doctor` shows PipeMD version** as the first health check line.
- **Daemon startup log includes version** — `PipeMD daemon starting (v1.2.0)...`.
- **`.status.json` and `.dashboard.json` include version**.
- **`.pipemd/.version` stamped at init** — `pmd refresh` warns on version drift.

### Added — Phase 2 Block Types
- **Script-based resolver system** — 41 block types across 7 ecosystems (TS/JS, Python, Go, Rust, Angular, Django, DevOps).
- **ast-grep integration** — structural code parsing for express-routes, fastapi-routes, react-components.
- **Dead-code block** — knip-based, self-caching. Dogfooded: removed 42 unused exports, 15 unused types, zod dependency.
- **Workspace-map, Angular-structure, Django-urls, Hotspots, Now** blocks.
- **Compact lint summaries** — rule frequency, severity split, `PMD_LINT_SEVERITY`.

### Changed — Daemon Performance
- **Content-hash gate** — the render loop now computes a cheap input signature (template stat + base.md stat + cached `git status` at 5s TTL) and skips the full render pipeline (N bash processes) if nothing changed. Eliminates >99% of wasted renders between tool calls.
- **Idle backoff** — when no reader has been seen for 60s, the render cadence slows from 1s to 30s. Snaps back to 1s on first reader.
- **FIFO write pump exponential backoff** — was retrying every 1s even with no reader (ENXIO). Now backs off 1s → 2s → 5s → 10s.
- **Cached git status in dashboard path** — was spawning `git status --porcelain` every 5s uncached.
- **Cached git SHA + dirty in relay poll** — was spawning two git processes every 5s.

### Removed
- **MCP server (568 LOC)** — zero production consumers.
- **`pmd task` CLI (146 LOC)** — orchestration, not context.
- **Dead resolvers** — `crew-todos`, `claimed-errors`, `git-context` before-edit (caches never written).
- **zod dependency** — replaced by dead-code block dogfooding.
- Net: ~836 LOC removed in Phase 0+1, plus continued trimming.

### Fixed — 36 Review Findings
- Concurrent resolver execution with per-item 4s timeout
- TOCTOU-safe pipe creation via mkfifo-at-temp + atomic rename
- Write-back buffer capped at 512KB
- Dedup per-source TTL stops indefinite suppression
- PID-based stale lock detection for dedup writes
- `unhandledRejection` no longer kills daemon
- ESM binary resolution fix for `@ast-grep/cli`
- Full list in commit `24ff188`

### Fixed — Plugin
- **OpenCode FIFO temp file cleanup** — temp files no longer accumulate in `$TMPDIR`.
- **OpenCode Effect.js `readAlloc` mitigation** — FIFO reads redirected to temp files (established earlier; now with cleanup).

## [1.1.2] — 2026-05-24

A hardening release focused on stability, security, and code quality. 10 commits, 67 files changed (+5,373 / −3,373). The daemon no longer blocks on shell commands, fatal errors clean up properly, credential files are protected, and the sync/async code duplication is eliminated. 96 unit tests (up from 7).

### Stability

- **Daemon event loop no longer blocks** — `execSync` in pipe command handler replaced with async `exec`; daemon stays responsive during command execution
- **Proper shutdown on fatal config errors** — `process.exit(1)` replaced with `shutdown([], 1)` so named pipes, PID files, and timers are cleaned up before exit
- **Claude Code Stop hook outputs valid JSON** — `hookSpecificOutput` is not supported for Stop events; now omitted from the response
- **Injection skips non-existent and external file paths silently** — instead of throwing errors on `--file` paths that are missing or outside the project root
- **Remote session handling fixed** — relay client correctly merges and expires remote crew sessions across reconnects
- **Session cache invalidation fixed** — stale crew sessions no longer persist after their TTL expires

### Security

- **Credential file permissions enforced** — relay token, PID, and port files are set to `0o600` (owner-only) on write and verified on read
- **Symlink traversal protection** — filesystem-walking scripts follow symlinks only within the project root
- **`eval` removed from `limit-core.sh`** — replaced with safe string operations
- **SECURITY.md added** — comprehensive threat model, attack surfaces with severity ratings, relay security documentation, reporting instructions

### Performance

- **Async hot path** — injection engine resolvers are fully async; no blocking I/O in the daemon pipe loop
- **Token profiles** — `config.ts` now exports `TOKEN_PROFILES` for context size limits (compact/standard/extended)
- **Detection performance** — `detect.ts` avoids redundant filesystem walks; caches results per run
- **Rate limiting** — injection engine caps at 30 injections per 10s per session; 5s total resolver budget

### Architecture

- **Daemon decomposition** — `daemon.ts` (477→198 lines) split into `daemon-config.ts`, `daemon-write-back.ts`, `legacy-watcher.ts`, `pipe-manager.ts`
- **Crew decomposition** — `crew.ts` (466→120 lines) split into `crew-process.ts` (process tree, identity resolution) and `crew-render.ts` (block rendering)
- **Sync/async deduplication** — eliminated duplicate resolver maps and render functions; single async code path for all resolvers (-220 lines net)
- **Init decomposition** — `init.ts` split into `init/scaffold.ts`, `init/scripts.ts`, `init/constants.ts`, `init/ui.ts`
- **`limit.sh` consolidation** — 8 identical per-ecosystem scripts replaced with single `Shared/lib/limit-core.sh`

### Code Quality

- **ESLint added** — `eslint.config.js` with `typescript-eslint`; all source linted (0 errors)
- **`process.exit` replaced with `UserError`** — CLI commands throw `UserError` instead of calling `process.exit()` directly
- **`ConfigError` class** — distinct error type for config validation failures
- **`TtlCache` utility** — generic time-to-live cache replacing ad-hoc expiry logic in `dedup.ts` and `crew-process.ts`
- **`errMsg()` utility** — consistent error message extraction across 100+ catch blocks with debug logging
- **`any` types eliminated** from core modules (injection-engine, dedup, crew, json-utils, pipe-manager, statusline-data)
- **Dead code removed** — unused `CacheManifest` interface, `getValidationResult` export

### Testing

- **96 unit tests** (up from 7) — migrated to `node:test` with proper isolation
  - `test-daemon-core.ts` (30) — pipe-manager state, isEpipe, updateStatus, timers, loadBase, composeContent, PID file, loadConfig, reverseInject, dedup
  - `test-crew.ts` (25) — isSessionStale, findConflicts, toRepoRelative, generateSessionId, filesystem CRUD
  - `test-injection-engine.ts` (13) — before-read, before-edit, dedup, triggers, hash, truncation, rate limiting
  - `test-injection-types.ts` (25) — parseInjectionConfig (null, passive, active, expert, invalid fields), computePayloadHash, getRulesForTrigger
  - `test-reverse-inject.ts` (7) — preserve edits, clean blocks, handle unknowns, interstitial text

### Docs

- **AI_SETUP_PIPEMD.md rewritten** — comprehensive onboarding guide for AI agents
- **README updated** — link and trace command documentation, `pmd run` usage
- **SECURITY.md** — token file permissions documented as enforced (updated from "not currently enforced")

## [1.1.0] — 2026-05-23

### Added

- **`pmd link` — Cross-machine crew federation** — connects PipeMD daemons across machines and Docker containers so crew sessions (agent coordination data) are shared in real time
  - `pmd-linkd` relay server — one per machine, aggregates crew sessions from all local daemons, syncs with remote relays
  - `POST /crew` endpoint — daemons push local sessions, receive merged remote sessions for their group
  - `POST /sync` endpoint — relay-to-relay bidirectional sync of all groups, bearer token auth
  - `GET /status` endpoint — monitoring: group counts, peer connection status
  - `GET /health` endpoint — liveness check
  - Named groups — coordination scopes that route sessions to the right project daemon (default: repo directory name, configurable via `link.group` or `PMD_GROUP` env var)
  - Daemon relay client — embedded in each daemon, auto-starts when `PMD_RELAY` or `link.relay` is configured
  - Remote session merge — `listSessions()` returns local + remote sessions; `renderCrewBlock()` tags remote agents with `· remote: <hostname>`
  - Cross-machine conflict detection — `findConflicts()` detects file claim conflicts across machines
  - Session expiry — remote sessions not refreshed within 15s are evicted from the relay's in-memory store
  - Docker support — container daemons connect to relay via `PMD_RELAY=http://relay:9741` (Docker DNS)
  - Zero new dependencies — pure Node.js `http` module

### Test Suite

- 121 assertions, 0 failures across 10 suites
- `test:unit` (19) — reverseInject + link relay unit tests
- `test:link` (17) — relay lifecycle, cross-origin exchange, group isolation, conflict detection, token auth
- All existing suites unchanged: e2e (36), bidir (27), arch (63), compose (17), crew (92), scripts (79), inject (47)

## [1.0.0] — 2026-05-21

### Added

- **Render-on-read daemon** — serves live context via OS-level named pipes (`mkfifo`)
- **Smart Context Injection** — event-driven, per-file context payloads delivered via harness hooks on `before-read`, `before-edit`, `after-edit`, `on-idle` triggers
- **Three delivery modes** — Passive (render-only), Active (hooks + sensible defaults), Expert (full `injection.yml` customization)
- **Bidirectional write-back** — AI edits outside `<!-- pmd: -->` blocks persist to disk; `reverseInject` de-renders blocks back to template form
- **Crew coordination** — multi-harness parallel-worker coordination with per-session JSON ledger, file claiming, conflict detection, and passive agent awareness
- **OpenCode TUI sidebar panel** — real-time PipeMD status, crew sessions, injection stats, hook event log rendered via `@opentui/solid` programmatic API
- **Architecture visualization** — Mermaid `graph TD` dependency diagrams for 7 ecosystems (Node/TypeScript, Python, Rust, Go, C/C++, DevOps, Generic)
- **Compose-md** — doc-assembly from multiple templates into one context file
- **Agent/File mode** — `pmd init` branches into Agent mode (daemon + pipes) or File mode (`pmd run` for CI/docs)
- **Headless mode** — `--yes`, `--mode`, `--output` flags for non-interactive CI usage
- **Auto-detection** — ecosystem detection (`detect.ts`) and AI harness detection (`detectHarness.ts`) for Claude Code, Gemini CLI, OpenCode, Cursor, Aider
- **Full harness hook coverage:**
  - Claude Code: 7 events (SessionStart, PreToolUse, PostToolUse, SubagentStart, SubagentStop, Stop, SessionEnd)
  - OpenCode: 3 handlers (tool.execute.before, tool.execute.after, session.idle) + server plugin v9 with injection tracking
  - Gemini CLI: 2 events (BeforeTool, AfterTool) with `--format gemini-json`
- **`pmd inject` command** — internal command resolving injection payloads; `--format` (plain, claude-hook, gemini-json), `--async-validate` self-spawn, `--session` dedup
- **Per-session deduplication** — content-hash based dedup across tool calls; stable session identity via `resolveAgentIdentity()` (process tree walk)
- **Async validation** — `--async-validate` spawns detached child for lint/type-check, returns immediately (doesn't block agent)
- **Script library** — 84 bash/python scripts across 8 categories (project, git, quality, architecture, db, api, frontend, cpp) for 7 ecosystems
- **`pmd doctor`** — diagnostics for daemon, config, scripts, crew sessions, hooks, injection config
- **`pmd status`** — daemon health, active pipes, last render time
- **`pmd refresh`** — sync scripts, add new ones without re-init
- **`pmd uninstall`** — clean removal with context backup/restore
- **Base/template separation** — `base.md` holds agent-authored instructions; `template.md` holds pmd blocks; composed with separator
- **Prompt cache optimization** — static rules at top, volatile data at bottom, ordered for LLM prefix cache warmth
- **Windows fallback** — legacy mode via chokidar file watcher when `mkfifo` unavailable
- **Security** — `execFileSync` with arg arrays everywhere (OpenCode plugin, eslint, tsc); no shell interpolation of user file paths

### Test Suite

- 368 assertions, 0 failures across 9 suites (2 pre-existing arch test exemptions)
- `test:unit` (7) — reverseInject logic
- `test:e2e` (36) — full CLI lifecycle (init/start/stop/run/pipe/doctor/file-mode/headless)
- `test:bidir` (27) — write-back, base.md, template edits
- `test:arch` (63) — architecture extraction across 7 ecosystems
- `test:compose` (17) — compose-md assembly
- `test:crew` (92) — crew lifecycle, hooks, TUI, status JSON, removal
- `test:scripts` (79) — all script categories across fixtures
- `test:inject` (47) — injection delivery, formats, dedup, validation, session isolation
