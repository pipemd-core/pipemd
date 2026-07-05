# Changelog

All notable changes to PipeMD.

## [2.0.0] — 2026-07-05

**The first stable release.** 1.x versions were development previews; 2.0.0 is the first version that works end-to-end from `npm install -g` through `pmd init` → `pmd start` → agent reads live context. Includes 15 versions of ML research (closed), a full performance overhaul, adapter parity across all three harnesses, and comprehensive security hardening.

### Breaking Changes
- `@ast-grep/cli` removed from dependencies. Users who want structural code parsing install it separately. Regex fallback works without it.
- `crew-todos` source fully removed (was dead — defaults didn't consume it, producer was plugin-only).
- `git-context` is now conditional (only fires when the file has uncommitted changes). Previously always-on.

### Added — ML Research Closure (V1–V15)
- **Topology filter** shipped in the active-mode baseline. V7's 15× label-spread signal as a deterministic file-type gate. V15 prospective A/B measured −30% input tokens at equal quality. Zero ML.
- **15-version ML research closed.** Verdict: injection helps on average (~−29s/step); "always inject within budget" is the best-supported policy; ML-based selection has not earned its place. Full findings in `docs/ml-lessons-for-main.md`.

### Added — Daemon Performance Overhaul
- **Content-hash gate** — the render loop computes a cheap input signature and skips the full pipeline (N bash processes) if nothing changed. Eliminates >99% of wasted renders between tool calls.
- **Idle backoff** — when no reader for 60s, cadence slows from 1s to 30s. Snaps back on first reader.
- **FIFO write pump exponential backoff** — was retrying every 1s with no reader. Now 1s → 2s → 5s → 10s.
- **Cached git status/SHA** in dashboard and relay paths. Was spawning 2+ git processes every 5s uncached.

### Added — Phase 2 Harden
- **Ecosystem-aware syntax checking** — TypeScript runs `tsc --noEmit` (project-wide, 30s cache). Python → `py_compile`. Go → `go vet`. Rust → `cargo check`.
- **`session-validate` resolver** — runs eslint on the active session's claimed files. Registered in after-edit + on-idle.
- **`pmd doctor` resolver health check** — runs each before-edit resolver and reports output size + latency.
- **Conditional `git-context`** — only fires when the file has uncommitted changes (V10: not significant).

### Added — Adapter Parity
- **All three adapters now cover 5/5 injection triggers** (before-read, before-edit, after-edit, on-idle, on-start). Previously: Claude 4/5, Gemini 3/5.
- **Gemini** gained on-start, on-idle, `--invalidate`, and crew join.
- **Claude** gained on-start inject hook.
- **OpenCode FIFO temp cleanup** — temp files no longer accumulate in `$TMPDIR`.

### Added — Versioning & DX
- **`pmd status` / `pmd doctor`** show the running version.
- **`.pipemd/.version`** stamped at init; `pmd refresh` warns on drift.
- **Daemon log** includes version at startup.
- **Layer 2 bench harness** (`pnpm bench`) — runs every resolver against 15 fixtures, token ratchet catches >15% growth.

### Added — Content Layer
- **`file-content` freshness** — mtime-aware caching, blank-line collapsing, smart head+tail truncation. V10's #1 reward block (−58.8s).
- **`import-graph` dependents-at-risk** — hub files (≥5 importers) get a risk annotation.

### Fixed — Release Blockers
- **Templates path** — added `templates/` to npm `files` whitelist. `pmd init` was ENOENT on published installs.
- **Gitignore** — `.pipemd/.gitignore` now uses allowlist approach. Ephemeral files (`.injection-log/`, `cache/`, `.status.json`, etc.) were leaking into git.
- **Shell injection** — `commandAvailable()` no longer interpolates bin names into shell strings.
- **Daemon start race** — atomic PID file creation via `O_EXCL` prevents dueling daemons.
- **`stopLogic` error swallowing** — EPERM now warns the user instead of silently removing the PID file.
- **PID file permissions** — now `chmod 0600` (matches SECURITY.md).
- **README/SECURITY accuracy** — corrected "real-time/sub-ms", "ephemeral/in-memory/15s", and `pmd init` claims.

### Changed
- **41 block types** across 7 ecosystems (TS/JS, Python, Go, Rust, Angular, Django, DevOps).
- **`pmd doctor`** includes version + resolver health sections.
- **CHANGELOG discipline** added to Definition of Done (`docs/discipline.md`).

### Removed
- MCP server (568 LOC) — zero production consumers.
- `pmd task` CLI (146 LOC) — orchestration, not context.
- `zod` dependency — replaced by dead-code block dogfooding.
- `@ast-grep/cli` runtime dependency — native-build blocker for global installs.

---

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

## [1.1.0] — 2026-05-23

### Added

- Gemini CLI adapter with BeforeTool/AfterTool hooks
- Docker DevOps support (compose, k8s-unhealthy)
- SQLAlchemy block
- Bidirectional write-back (AI edits outside pmd: blocks persist)
- `pmd trace` — live TUI for crew coordination debugging
- `pmd link` — cross-machine relay (beta)
- `PMD_TOKEN_PROFILE` for controlling block output size
- Native named-pipe context delivery (zero disk writes on macOS/Linux)

### Test Suite

- E2E suite: 25 tests covering init, run, start, stop, pipe reads, doctor
- 7 unit test files ( TTL cache, detect, crew render, daemon core, reverse inject, link, crew)

## [1.0.0] — 2026-05-21

Initial development preview. Not recommended for production use — superseded by 2.0.0.
