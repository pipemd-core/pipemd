# Changelog 

All notable changes to PipeMD.

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
