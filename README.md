<p align="center">
  <picture>
    <img src="PipeMD.jpg" alt="PipeMD Banner" width="100%" style="border-radius: 8px; max-width: 800px;" />
  </picture>
</p>

<h1 align="center">PipeMD</h1>

<p align="center">
  <strong>The Dynamic Context Harness for AI Coding Agents.</strong><br>
  <em>Never let Claude, Cursor, or Aider hallucinate on stale project state again.</em>
</p>

<p align="center">
  <a href="#the-magic-render-on-read"><img src="https://img.shields.io/badge/Architecture-Render--on--Read%20%2B%20Smart%20Injection-blue?style=flat-square" alt="Architecture"></a>
  <a href="#prompt-cache-optimization"><img src="https://img.shields.io/badge/Prompt%20Caching-Optimized-success?style=flat-square" alt="Prompt Cache Optimized"></a>
  <a href="#compatibility"><img src="https://img.shields.io/badge/Works%20With-Claude%20%7C%20Cursor%20%7C%20Aider%20%7C%20Gemini-orange?style=flat-square" alt="Works With"></a>
  <a href="https://opensource.org/licenses/ISC"><img src="https://img.shields.io/badge/License-ISC-purple?style=flat-square" alt="License"></a>
</p>

---

## 🛑 The Problem: Stale Context & Git Churn

AI coding agents need to know your current project state (git status, lint errors, TODOs) to be effective.
Currently, you have two bad options:
1. **Static Files:** You give the AI a `README.md` or `CONTEXT.md`. It goes stale after your first commit. The AI hallucinates.
2. **Automated Scripts:** You run a script to update `CONTEXT.md` continuously. Your `git status` is ruined, merge conflicts run rampant, and your file history is a mess.

## ⚡ The Solution: PipeMD

PipeMD uses a brilliantly simple OS-level trick: **Named Pipes**.

It creates an `AGENTS.md` file in your root directory that is actually a `mkfifo` pipe. When your AI agent attempts to read it, PipeMD intercepts the read, executes your bash scripts concurrently, injects real-time project state into a clean template, and streams it straight to the AI.

*   **Zero Git Churn:** The template is clean. The live output is completely ephemeral.
*   **Always Fresh:** The AI gets up-to-the-millisecond data *only* exactly when it reads.
*   **Secure:** Commands run from your own `config.yml` — no need to grant the AI unsafe terminal execution permissions.

But named pipes only solve half the problem: most AI agents read their context file only once at session start, then cache it. PipeMD's **Smart Context Injection** solves this by installing lightweight hooks that inject fresh, scoped context directly into the agent's working memory on every tool call — crew locks before edits, file errors before edits, validation results after edits, and status updates during idle time.

PipeMD is a render-on-read daemon that uses OS-level named pipes (mkfifo) to serve real-time project context to
AI coding agents. The key innovation: the file the AI reads (AGENTS.md or AI_CONTEXT.md) is itself a named pipe --
 when the AI opens it, the daemon intercepts the read, executes all configured shell commands concurrently,
assembles the output into a Markdown template, prepends any base instructions (from `.pipemd/base.md`), and streams it back.

Data flow:

The Full Data Flow
Agent tool call
  → Harness hook fires (Claude: settings.json entry, OpenCode: plugin handler, Gemini: settings.json entry)
    → `pmd inject --trigger <X> --file <Y> --session <Z> --format <F>`
      → `resolveInjections()` in injection-engine.ts
        → Loads injection.yml config
        → Gets rules for trigger
        → For each rule, runs the resolver (crew-status, file-errors, git-context, etc.)
        → `checkInjectionStatus()` in dedup.ts -- checks `.pipemd/cache/injected/<session>.json`
        → If "unchanged": skip (no payload returned)
        → If "new"/"changed": `recordInjection()` -- writes hash to `.pipemd/cache/injected/<session>.json`
        → Returns `InjectionPayload[]`
      → `bumpInjectStats()` in statusline-data.ts -- writes `.pipemd/.inject-stats.json`
      → Output in requested format (plain, claude-hook JSON, gemini JSON)
  → OpenCode only (plugin side):
    → Also calls `pushEvent()` which writes `.pipemd/.tui-stats.json`
    → TUI panel reads `.pipemd/.tui-stats.json` every 2s
  → `pmd statusline` (called by Claude Code automatically, or Gemini AfterAgent):
    → Reads `.pipemd/.inject-stats.json`, `.pipemd/.status.json`, `.pipemd/.crew-status.json`
    → Renders status line to developer

.pipemd/base.md (committed, agent's own instructions)
    ─────────────────────────────────────────────────────┐
                                                        │
.pipemd/template.md (committed, static)                 │
    → daemon reads tags like <!-- pmd: git-status -->    │
    → runs commands concurrently via Promise.allSettled   │
    → assembles rendered Markdown                        │
    → composes: base + "---\n\n<!-- pmd-context -->\n" + rendered template
    → serves via named pipe (AGENTS.md) on read          │

Two operational modes:

1. Pipe Mode (macOS, Linux, WSL): Uses mkfifo to create named pipes. The root context file IS the pipe. Zero git
churn. Supports bidirectional write-back — edits above `<!-- pmd-context -->` are saved to `base.md`,
edits outside `<!-- pmd: -->` blocks in the template section are de-rendered and saved back to `template.md`.

2. Legacy Mode (native Windows fallback): Uses chokidar to watch template.md, writes rendered output to a regular
file marked read-only (0o444). This causes git churn. Also supports write-back via file watcher.


---

## ✨ Features: Built for Vibe Coding

- **🔌 Universal AI Compatibility:** Claude Code, Gemini CLI, OpenCode, Cursor, Aider—it doesn't matter. If your AI agent can read a Markdown file, it works flawlessly with PipeMD. No plugins required.
- **🏗️ Architecture Maps:** PipeMD generates live Mermaid dependency graphs (`graph TD`) for 7 ecosystems. AI agents get an instant mental model of your project's module structure — no need to read dozens of files to understand how things connect.
- **🦾 Self-Improving Context:** Because your fetch scripts and templates live as plain text in `.pipemd/`, you can simply ask your AI to *edit its own context harness* to feed itself better data on the fly. Meta-coding at its finest.
- **🛡️ Non-Destructive Setup:** Worried about losing your carefully crafted system prompts? `pmd init` is completely non-destructive. If an `AGENTS.md` or `AI_CONTEXT.md` already exists, PipeMD saves your instructions to `.pipemd/base.md` and keeps them separate from the template. Nothing gets overwritten.
- **👻 Ephemeral & Git-Clean:** Output is generated in memory and streamed via the named pipe. The target file is automatically `.gitignored` and vanishes the second you stop the daemon. Zero commit noise.
- **🧠 Prompt Cache Optimized:** Static rules stay at the top; highly volatile data (like `git status`) is anchored to the bottom. Your LLM prefix cache stays warm, giving you instant responses and saving massive amounts of tokens.
- **🏎️ Concurrent & Fail-Safe:** Data-gathering scripts run concurrently so your AI isn't left waiting. Built-in 10-second timeouts and isolated failures mean one broken script won't crash your entire context stream.
- **🤖 Smart Scaffolding:** Run `pmd init` and watch it automatically detect your ecosystem (Node, Python, TS, etc.) to scaffold the exact bash scripts you need to hit flow state immediately.
- **🎯 Smart Context Injection:** Goes beyond render-on-read. Hooks inject fresh, scoped context into your agent's working memory on every tool call — crew locks, file errors, validation results — so the agent always knows the current state even mid-session.

---

## 🚀 Quick Start

Get your dynamic context harness running in under 60 seconds:

```bash
# Option 1: Global Install
npm install -g pipemd
pmd init
pmd start

# Option 2: Run via NPX (No global install required)
npx pipemd init
npx pipemd start
```

> **Bash Required:** PipeMD's context scripts rely on a Bash environment. Windows users must use WSL or Git Bash.

*The setup wizard will auto-detect your ecosystem and configure the optimal `.pipemd/template.md` and context scripts for your workspace.*

*The setup wizard will also ask how to deliver context — **Active** (recommended for most agents) or **Passive** (for Cursor, Aider, or CI).*

---

## 🧠 How the Magic Works

PipeMD bridges the gap between your static developer notes and the dynamic reality of your repository.

```text
┌────────────────────────────────────────────────────────┐
│  1. You edit: .pipemd/template.md                      │
│  (Clean, committed to Git, your source of truth)       │
│                                                        │
│  ## Rules                                              │
│  Never use `any` in TypeScript.                        │
│                                                        │
│  ## Live Diff                                          │
│  <!-- pmd: diff -->   <── PipeMD placeholder           │
└────────────────────────┬───────────────────────────────┘
                         │
        (Agent reads AGENTS.md from root)
                         │
┌────────────────────────▼───────────────────────────────┐
│  2. PipeMD Daemon (Intercepts read)                    │
│  Prepends base.md + separator, renders template...     │
└────────────────────────┬───────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────┐
│  3. The AI receives: (Streamed instantly)              │
│                                                        │
│  [Base instructions from .pipemd/base.md]              │
│                                                        │
│  ---                                                   │
│                                                        │
│  <!-- pmd-context -->                                  │
│                                                        │
│  ## Rules                                              │
│  Never use `any` in TypeScript.                        │
│                                                        │
│  ## Live Diff                                          │
│  + const daemon = new PipeMD();                        │
│  - const daemon = null;                                │
└────────────────────────────────────────────────────────┘
```

> **Note for Windows Users:** Native Windows lacks `mkfifo`. PipeMD falls back to **Legacy Mode**, gracefully watching your template and writing read-only (`0o444`) updates.

---

## 🧠 Smart Context Injection

Most AI coding agents load their context file once at session start and never re-read it. This means even with named pipes serving fresh data, the agent works with stale information for the entire session.

PipeMD's Smart Context Injection solves this by installing per-harness hooks that inject relevant context **on every tool call**, scoped to what the agent is about to do:

```text
Agent is about to READ a file:
  → Hook fires → "Crew: this file is unclaimed. Safe to read."

Agent is about to EDIT src/foo.ts:
  → Hook fires → "File src/foo.ts: claimed by OpenCode (cr_abc123) 45s ago
                   Type-check: 2 errors in this file
                   Last edit: you, 2 minutes ago"

Agent just EDITED src/foo.ts:
  → Background validation triggers → next tool call shows:
     "After your edit to src/foo.ts: 1 error remaining (was 2)"

Agent has been idle for 10 seconds:
  → "Crew: Gemini session joined. Git: 1 new uncommitted file."
```

### Three Delivery Modes

During `pmd init`, choose how PipeMD delivers context to your agent:

| Mode | How it works | Best for |
|------|-------------|----------|
| **Active** (recommended) | Hooks installed. Fresh context injected on every tool call. Zero config. | Claude Code, OpenCode, Gemini CLI |
| **Passive** | Context rendered to file/pipe. Agent reads at session start. No hooks. | Cursor, Aider, CI/CD |
| **Expert** | Full control over injection rules via `.pipemd/injection.yml`. | Teams with custom workflows |

### What gets injected

Active mode injects context at four moments:

| Trigger | Sources |
|---------|---------|
| **Before Read** | Crew status (who's working, any conflicts) |
| **Before Edit** | Crew locks for target file, lint/type errors for target file, git context |
| **After Edit** | Async validation: run lint + type-check on edited file, deliver results on next call |
| **On Idle** | Crew status changes, git delta since last check |

All injection is **deduplicated** — unchanged data is skipped, saving tokens. Results are cached with per-source TTL for sub-5ms hook latency.

### The injection.yml file (Expert mode)

```yaml
# .pipemd/injection.yml — customize injection rules
delivery: expert
rules:
  before-edit:
    - source: crew-locks
      scope: target-file
    - source: file-errors
      scope: target-file
      max-lines: 5
  after-edit:
    - source: validate-file
      scope: target-file
      async: true
```

---

## 🛠️ Commands

PipeMD is designed to stay out of your way.

| Command | Description |
|---------|-------------|
| `pmd init` | **Interactive setup:** Auto-detects ecosystem + harnesses, scaffolds the template, scripts, and `.gitignore` entries. `--headless` for CI. |
| `pmd start` | **Spawns daemon:** Creates the named pipe(s) and silently serves context on read. Daemon detaches and stores its PID in `.pipemd/.daemon.pid`. |
| `pmd stop` | **Kills daemon:** Safely removes all pipes and cleans up the PID file. |
| `pmd restart` | **Stop + start:** Reloads `config.yml` (use after editing config). |
| `pmd status` | **System health:** Shows active daemon PID, watched files, active pipes, and recent log lines. |
| `pmd run` | **One-shot render:** Renders the resolved template to `stdout` or a file (`-o`). No daemon required — ideal for CI and pre-commit hooks. |
| `pmd refresh` | **Sync scripts:** Pulls newer bundled scripts into `.pipemd/scripts/`, offers newly added ones (e.g. **Crew Activity**), and rewrites `config.yml`. |
| `pmd doctor` | **Diagnose:** Checks for `mkfifo`, stale PIDs, missing scripts, and config drift. |
| `pmd crew` | **Multi-harness coordination:** Register agents, claim files, surface conflicts (see below). |
| `pmd uninstall` | **Clean removal:** Restores the original context file and strips PipeMD artifacts. |

---

## 👥 Crew: Coordinating Parallel Agents

When several AI harnesses work the same repo at once (e.g. OpenCode with 8
sub-agents plus a Claude CLI session), they edit blind to each other. PipeMD
Crew turns the live context file into a shared awareness layer.

The model is **Harness → Coordinator → sub-agents**: one coordinator per
harness, with PipeMD as the neutral meta-coordinator that renders the union.

| Command | Description |
|---------|-------------|
| `pmd crew join` | Register this agent (`--role coordinator\|worker`, `--label`). |
| `pmd crew claim <file…>` | Mark files as being worked on (`--note "<task>"`). |
| `pmd crew release <file…>` | Release claims (`--all` for everything). |
| `pmd crew note "<text>"` | Post the current task/status. |
| `pmd crew status` | Show the live crew tree. |
| `pmd crew leave` | Deregister this agent. |
| `pmd crew install-hooks` | Auto-wire harness hooks so edits self-report. |

**Two signal layers.** *Passive* (always on, zero cooperation): observed git
churn and running harness processes. *Active* (opt-in): the `pmd crew` CLI,
fired automatically by `pmd crew install-hooks`:

| Harness | Events | Wired into |
|---------|---------|------------|
| Claude Code | `SessionStart` → join, `PreToolUse` → heartbeat, `PostToolUse` → claim, `SubagentStart/Stop` → worker lifecycle, `SessionEnd` → leave, `statusLine` → live PipeMD statusline | `.claude/settings.json` |
| OpenCode | `tool.execute.before` → heartbeat, `tool.execute.after` → claim, `session.idle` → keep-alive | `.opencode/plugin/pmd-crew.js` |
| Gemini CLI | `BeforeTool` → heartbeat, `AfterTool` → claim, `SessionStart`/`AfterAgent` → live PipeMD statusline via hook `systemMessage` (v0.26+) | `.gemini/settings.json` |
| Cursor / Aider / others | no edit-event API | injected Coordination Protocol text |

The crew block (`<!-- pmd: crew -->`) is rendered into every harness's context
file, so a `⚠️ CONFLICT` — two agents claiming the same file — appears for
everyone within one broadcast cycle. Add it via `pmd refresh` (select **Crew
Activity**) or pick it during `pmd init`.

**Claude Code statusline.** OpenCode gets a live TUI sidebar panel; Claude Code
has no pluggable panel, so `install-hooks` instead registers a `statusLine` that
renders the same dev-side state — daemon up/down, crew session count, passive
agents, file conflicts, context size, injection counts — on a single line at the
bottom of the Claude Code UI. It is invoked automatically by the harness on every
update; a pre-existing custom `statusLine` is never overwritten. Preview it any
time with `pmd statusline --plain`.

---

## 🏗️ What Gets Generated?

PipeMD keeps your root directory pristine. Everything lives in `.pipemd/`.

```text
your-project/
├── .pipemd/
│   ├── config.yml           # ✅ Committed — pipe routing + script definitions
│   ├── base.md              # ✅ Committed — agent's own instructions (prepended to context)
│   ├── template.md          # ✅ Committed — 📝 edit this! The static wrapper for your context.
│   ├── scripts/             # ✅ Committed — Bash/Python/Node data-gathering scripts
│   │   ├── architecture/    #   🏗️ Architecture map (Mermaid graph TD)
│   │   ├── project/         #   Project structure, deps, todos
│   │   ├── git/             #   Git state scripts
│   │   ├── quality/         #   Type checking, linting, tests
│   │   └── crew/            #   Crew coordination block
│   ├── injection.yml       # ✅ Committed — Smart injection rules (active/expert mode)
│   ├── cache/              # (Gitignored) Per-source render cache for injection
│   │   ├── sources/        #   Cached command outputs with TTL
│   │   ├── validation/     #   Per-file validation results
│   │   └── injected/       #   Per-session dedup records
│   ├── live/                # (Gitignored) Ephemeral named pipes
│   ├── crew/                # (Gitignored) Per-agent coordination ledger (JSON)
│   ├── daemon.log           # (Gitignored) Daemon activity log
│   └── .daemon.pid          # (Gitignored) Running daemon's PID
├── AGENTS.md                # (Gitignored) 🏴‍☠️ The Named Pipe. The AI reads this.
└── .gitignore               # Updated automatically by `pmd init`
```

> Only `config.yml`, `base.md`, `template.md`, and `scripts/` are committed —
> everything your team needs to reproduce the harness, and nothing ephemeral.

---

## 🎯 The Template (`.pipemd/template.md`)

This is your source of truth. Edit it, commit it, share it with your team. Use `<!-- pmd: command_name -->` to tell the daemon where to inject live data.

The served context file is composed of two parts: **base instructions** (from `.pipemd/base.md`) and the **rendered template**. They are separated by `---` + `<!-- pmd-context -->`. AI edits above the separator go back to `base.md`; edits in the template section outside `<!-- pmd: -->` blocks go back to `template.md`.

```markdown
# 🏴‍☠️ AI Context — powered by PipeMD

> **🤖 PipeMD Context File**
>
> This file is maintained by PipeMD. It refreshes automatically.
>
> - Content inside `<!-- pmd: -->` blocks is **read-only** — the daemon overwrites it every cycle.
> - Everything else is **yours to edit**. Edits persist via bidirectional write-back.
> - Edits above `<!-- pmd-context -->` route to `.pipemd/base.md`. Edits below it route to `.pipemd/template.md`.
> - For full details, read `.pipemd/AI_SETUP_PIPEMD.md`.

## 🏗️ Architecture
<!-- pmd: arch -->
```

```
<!-- /pmd -->

## 📁 Project Structure
<!-- pmd: tree -->
<!-- /pmd -->

## 📝 TODOs
<!-- pmd: todos -->
<!-- /pmd -->

---
## 🚨 Volatile State
<!-- pmd: diff-stat -->
<!-- /pmd -->
```

*(Notice how volatile data like `diff-stat` is placed at the bottom? This ensures your LLM Prompt Cache hits for the top 90% of the document!)*

---

## ⚙️ Configuration (`config.yml`)

The `config.yml` connects the `pmd:` tags in your template to the actual scripts that fetch the data.

```yaml
version: "1.0"

# ⚠️ Security Warning: PipeMD executes the commands below exactly as written.
# Do not run PipeMD in an untrusted repository.

# Optional: Base instructions file, prepended to the served context.
# AI edits to the base section are written back here.
base: ".pipemd/base.md"

commands:
  arch: "bash .pipemd/scripts/architecture/arch.sh"
  tree: "bash .pipemd/scripts/project/tree.sh"
  diff-stat: "bash .pipemd/scripts/git/diff-stat.sh"
  todos: "bash .pipemd/scripts/project/find-todos.sh"

pipes:
  - file: "AGENTS.md"               # The file the AI Agent reads
    render: ".pipemd/template.md"   # The template to populate
```

### Shared Scripts
Because `.pipemd/scripts/` is committed to git, your whole team gets the exact same context harness. Drop any language script in there (`.sh`, `.py`, `.js`) to pull test results, type-check errors, or database schemas.

---

## 🤖 For AI Agents

If you are an AI agent reading a PipeMD context file, here is the contract:

**Reading.** The file you read (`CLAUDE.md`, `AGENTS.md`, …) is a *live render*.
Prefer the data inside `<!-- pmd: -->` blocks over running your own shell
commands — it is current as of the moment you opened the file.

**Editing.** The file is split by a `<!-- pmd-context -->` separator:

| Where you edit | Where it persists | Notes |
|---|---|---|
| Above the separator | `.pipemd/base.md` | Your own rules and instructions. |
| Below it, *outside* `<!-- pmd: -->` blocks | `.pipemd/template.md` | Section headers, notes, checkboxes. |
| *Inside* a `<!-- pmd: -->` block | **nowhere** | Overwritten every refresh cycle — never edit here. |

**Self-improvement.** Because the harness is plain text, you can tune your own
context: add/remove `<!-- pmd: -->` blocks in `.pipemd/template.md`, change
which scripts run in `.pipemd/config.yml`, or adjust the token profile. See
`.pipemd/AI_SETUP_PIPEMD.md` (scaffolded into every project) for the full guide.

**Working alongside other agents.** If a **Crew Activity** block is present,
read it before editing — it lists which files other agents hold. A
`⚠️ CONFLICT` line means another agent claimed a file you are about to touch;
treat it as blocking. Announce your own work with `pmd crew claim <file>` and
`pmd crew note "<task>"` (or let the installed hooks do it automatically).

**Smart Injection.** If the project uses Active or Expert delivery mode, PipeMD hooks inject fresh context into your working memory on every tool call. You'll see messages like `[pmd:crew-locks → src/foo.ts]` before edits and `[pmd:validate-file → src/foo.ts]` after edits. This data is:

- **Scoped**: you only see context relevant to the file you're about to touch
- **Deduplicated**: repeated unchanged data is silently skipped
- **Cache-backed**: hook latency is under 5ms

---

## 🔒 Safety & Edge Cases Handled

> **⚠️ Security Warning:** PipeMD executes the commands in `config.yml` exactly as written. Do not run PipeMD in an untrusted repository.

Building a background daemon that streams live data into AI systems requires aggressive safety guardrails. PipeMD includes:

*   **10-Second Timeouts:** No runaway `grep` commands hanging your AI. If a script stalls, it gets killed.
*   **Isolated Rendering:** Built on `Promise.allSettled`. If your `test-summary.sh` fails, the error is rendered *in-place* inside the markdown file, and the rest of the document loads perfectly.
*   **EPIPE Catching:** If Claude Code closes the stream mid-read to save tokens, PipeMD safely catches the `EPIPE` disconnect without crashing the daemon.
*   **Stale PID Recovery:** If your machine forcefully reboots, `pmd start` instantly detects the dead process, cleans up the old pipes, and starts fresh.

---

## 🧑‍💻 For Developers

PipeMD is strict TypeScript, **ESM-only** (imports use `.js` extensions,
`NodeNext` resolution), built with `tsup`, and targets Node.js 18+.

### Build & test

```bash
pnpm install       # Install dependencies
pnpm build         # Production build → dist/ (run before any e2e test)
pnpm dev           # Watch mode — rebuilds on change
tsc --noEmit       # Type-check only

pnpm test          # Full suite: unit → e2e → bidir → scripts → arch → compose → crew
pnpm test:unit     # reverseInject logic (pure Node, no build needed)
pnpm test:crew     # Crew coordination lifecycle (needs build)
```

There is no test framework: unit tests use `node:assert`, e2e tests are Bash
scripts with custom assertion helpers in `tests/`.

### Source layout

```text
src/
├── index.ts            # CLI entry — Commander program, registers all commands
├── config.ts           # PipeConfig type + DEFAULT_CONFIG
├── commands/            # One file per command: init, start, stop, restart,
│                        #   status, run, refresh, doctor, uninstall, crew
└── core/
    ├── daemon.ts        # Daemon loop — pipe mode (mkfifo) + legacy mode (chokidar)
    ├── injector.ts      # Renders <!-- pmd: --> blocks; reverseInject write-back
    ├── cache.ts            # Per-source render cache with TTL + invalidation
    ├── injection-types.ts  # Injection config schema, types, defaults
    ├── injection-engine.ts # Rules engine — resolves sources, dedup, truncation
    ├── dedup.ts            # Per-session dedup — skips unchanged content
    ├── detect.ts        # Ecosystem auto-detection (Node, Python, Rust, …)
    ├── detectHarness.ts # AI-harness detection (Claude Code, OpenCode, …)
    ├── crew.ts          # Crew ledger, conflict detection, block rendering
    ├── hooks.ts         # Per-harness hook installers (crew + injection)
    ├── actions.ts       # start/stop/cleanup logic
    └── logger.ts        # File logger → .pipemd/daemon.log

scripts/                 # Bundled Bash library, by ecosystem & category
templates/               # Per-ecosystem Markdown templates
tests/                   # e2e-*.sh suites + test-reverse-inject.mjs + fixtures/
```

### The render pipeline

1. `daemon.ts` reads `.pipemd/template.md` and finds `<!-- pmd: name -->` tags.
2. `injector.ts` runs each tag's command (from `config.commands`) concurrently
   via `Promise.allSettled`, with a 10 s timeout per command.
3. Rendered blocks replace the tags; `base.md` is prepended with the
   `<!-- pmd-context -->` separator.
4. The composed Markdown is served on the named pipe (or written in legacy mode)
   to every harness's context file.
5. AI edits flow back: `reverseInject` de-renders `pmd` blocks and persists
   edits to `base.md` / `template.md`.

### Smart injection pipeline (Active/Expert mode)

1. Harness hook fires (e.g., Claude Code `PreToolUse:Edit` on `src/foo.ts`)
2. Hook calls `pmd inject --trigger before-edit --file src/foo.ts`
3. Injection engine loads rules from `injection.yml`
4. For each matching rule, runs the source resolver (crew-locks, file-errors, git-context...)
5. Each resolver reads from the render cache (sub-5ms)
6. Dedup layer checks: skip if content unchanged since last injection
7. Payloads printed to stdout → agent sees them as hook output
8. For after-edit triggers: async validation (eslint + tsc) runs in background, cached for next call

PRs welcome — see `CLAUDE.md` for conventions and gotchas, `SPEC.md` for the
full specification.

## 📜 License

**ISC License** © Ivann Rudrauf
