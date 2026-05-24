# Contributing to PipeMD

PipeMD is strict TypeScript, **ESM-only** (imports use `.js` extensions, `NodeNext` resolution), built with `tsup`, and targets Node.js 18+.

## Build & Test

```bash
pnpm install
pnpm build            # Production build → dist/
pnpm dev              # Watch mode — rebuilds on change
tsc --noEmit          # Type-check only

pnpm test             # Full suite: unit → e2e → bidir → scripts → arch → compose → crew
pnpm test:unit        # reverseInject logic (pure Node, no build needed)
pnpm test:crew        # Crew coordination lifecycle (needs build)
```

There is no test framework: unit tests use `node:assert`, e2e tests are Bash scripts with custom assertion helpers in `tests/`.

## Source Layout

```
src/
├── index.ts            # CLI entry — Commander program, registers all commands
├── config.ts           # PipeConfig type + DEFAULT_CONFIG
├── commands/           # One file per command: init, start, stop, restart,
│                       #   status, run, refresh, doctor, uninstall, crew, link
│                       #   init/ subdirectory: constants.ts, scaffold.ts, scripts.ts, ui.ts
└── core/
    ├── daemon.ts       # Daemon loop — pipe mode (mkfifo) + legacy mode (chokidar)
    ├── injector.ts     # Renders <!-- pmd: --> blocks; reverseInject write-back
    ├── cache.ts        # Per-source render cache with TTL + invalidation
    ├── injection-types.ts  # Injection config schema, types, defaults
    ├── injection-engine.ts # Rules engine — resolves sources, dedup, truncation
    ├── dedup.ts        # Per-session dedup — skips unchanged content
    ├── detect.ts       # Ecosystem auto-detection (Node, Python, Rust, …)
    ├── detectHarness.ts # AI-harness detection (Claude Code, OpenCode, …)
    ├── crew.ts         # Crew ledger, session management, conflict detection
    ├── crew-process.ts # Crew session lifecycle (join, leave, claim, heartbeat)
    ├── crew-render.ts  # Crew block rendering (tree, lock map, timeline)
    ├── hooks.ts        # HarnessAdapter interface + adapter registry
    ├── hook-utils.ts   # Shared hook installation utilities (JSON-based harnesses)
    ├── opencode-hooks.ts  # OpenCode-specific hook installer
    ├── claude-hooks.ts # Claude Code-specific hook installer
    ├── gemini-hooks.ts # Gemini CLI-specific hook installer
    ├── actions.ts      # start/stop/cleanup logic
    ├── daemon-config.ts # Config loading + validation
    ├── daemon-write-back.ts # Bidirectional write-back handler
    ├── fs-utils.ts     # Atomic file write with O_EXCL
    ├── legacy-watcher.ts # File watcher for legacy (non-pipe) mode
    ├── pipe-manager.ts # Named pipe creation, serving, and write-safe handling
    ├── statusline-data.ts # Injection stats and statusline reporting
    ├── json-utils.ts   # Shared JSON read/write helpers
    ├── errors.ts       # UserError class for CLI-facing errors
    ├── logger.ts       # File logger → .pipemd/daemon.log
    ├── ttl-cache.ts    # Generic TTL cache (used by crew-render)
    └── net/            # Cross-machine federation (pmd link)
        ├── protocol.ts # Shared types, constants (CrewMessage, SyncMessage)
        ├── relay.ts    # pmd-linkd server (in-memory store, peer sync)
        └── daemon-client.ts # Daemon-side HTTP client (push/pull sessions)

src/plugins/             # Harness-specific runtime plugins
    ├── opencode-server.js  # OpenCode plugin (hooks + injection + crew)
    └── opencode-tui.js     # OpenCode TUI panel (Solid.js)

scripts/                # Bundled Bash library, by ecosystem & category
templates/              # Per-ecosystem Markdown templates
tests/                  # Unit tests (tsx) + e2e suites (bash)
```

## The Render Pipeline

1. `daemon.ts` reads `.pipemd/template.md` and finds `<!-- pmd: name -->` tags.
2. `injector.ts` runs each tag's command (from `config.commands`) concurrently via `Promise.allSettled`, with a 10s timeout per command.
3. Rendered blocks replace the tags; `base.md` is prepended with the `<!-- pmd-context -->` separator.
4. The composed Markdown is served on the named pipe (or written in legacy mode) to every harness's context file.
5. AI edits flow back: `reverseInject` de-renders `pmd` blocks and persists edits to `base.md` / `template.md`.

## Smart Injection Pipeline (Active/Expert Mode)

1. Harness hook fires (e.g., Claude Code `PreToolUse:Edit` on `src/foo.ts`)
2. Hook calls `pmd inject --trigger before-edit --file src/foo.ts`
3. Injection engine loads rules from `injection.yml`
4. For each matching rule, runs the source resolver (crew-locks, file-errors, git-context…)
5. Each resolver reads from the render cache (sub-5ms)
6. Dedup layer checks: skip if content unchanged since last injection
7. Payloads printed to stdout → agent sees them as hook output
8. For after-edit triggers: async validation (eslint + tsc) runs in background, cached for next call

## Safety & Edge Cases

- **10-Second Timeouts:** No runaway commands hanging the AI. Stalled scripts get killed.
- **Isolated Rendering:** Built on `Promise.allSettled`. A failing script renders an error in-place; the rest of the document loads fine.
- **EPIPE Catching:** If an agent closes the stream mid-read, PipeMD catches the disconnect without crashing.
- **Stale PID Recovery:** `pmd start` detects dead processes, cleans up old pipes, and starts fresh.

PRs welcome. See `CLAUDE.md` for conventions and gotchas.
