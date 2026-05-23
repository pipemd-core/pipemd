# PipeMD — AI Agent Quickstart

> You are operating inside a PipeMD-managed project. This file explains everything you need to know in 2 minutes.

## The Big Picture

PipeMD is a **live context system** for AI coding agents. Instead of static `AGENTS.md` files that go stale, PipeMD:

1. **Serves live data** — `AGENTS.md` is a named pipe. When you read it, the daemon runs scripts and streams fresh results.
2. **Injects context on every tool call** — hooks deliver scoped, file-specific data (crew locks, errors, git state) directly into your working memory.
3. **Coordinates multiple agents** — crew sessions track who's editing what, with conflict detection across files, machines, and Docker containers.

**Result:** You always have up-to-the-millisecond project state. No stale context. No git churn.

---

## The Context File

The file you read (e.g. `AGENTS.md`, `CLAUDE.md`) is **not a static file**. It's a live document with two zones:

```
┌─────────────────────────────────────┐
│  Base section (above separator)     │
│  ✏️  Editable — your rules persist  │
├─────────────────────────────────────┤
│  <!-- pmd-context -->               │
├─────────────────────────────────────┤
│  Template section (below separator) │
│  ✏️  Editable outside pmd: blocks   │
│  🔄 pmd: blocks = live script data  │
└─────────────────────────────────────┘
```

### What you CAN edit

| Where | Persists to | Examples |
|-------|------------|----------|
| Above `<!-- pmd-context -->` | `.pipemd/base.md` | Your custom rules, notes, checklists |
| Below `<!-- pmd-context -->`, outside `<!-- pmd: -->` blocks | `.pipemd/template.md` | Section headers, labels, descriptions |

### What you CANNOT edit

Anything inside `<!-- pmd: ... -->` ... `<!-- /pmd -->` blocks. The daemon overwrites these every cycle. Your edits will be lost.

---

## The Data Blocks

Each `<!-- pmd: -->` block runs a script and shows the result:

| Block | What it shows | Volatility |
|-------|--------------|------------|
| `arch` | Mermaid dependency graph | Stable |
| `tree` | Project file tree | Stable |
| `deps` | Package dependencies | Stable |
| `todos` | TODO / FIXME / HACK comments | On commit |
| `git-log` | Recent commits | On commit |
| `git-branch` | Current branch, tracking status | On commit |
| `type-check` | TypeScript errors | On commit |
| `git-status` | Modified / staged / untracked files | On save |
| `diff-stat` | Line-level diff summary | Continuous |
| `crew` | Active agents, file claims, conflicts | Continuous |

**Use the blocks instead of running commands.** If you need git status, read the `git-status` block — don't run `git status`. The blocks are faster, cheaper, and always current.

---

## Smart Context Injection

If this project uses **Active** or **Expert** delivery mode, PipeMD injects fresh context into your working memory on every tool call. You'll see messages like:

```
[pmd:crew-locks → src/foo.ts]
File src/foo.ts: claimed by Claude Code (cr_abc123) 30s ago
```

```
[pmd:validate-file → src/foo.ts]
After your edit to src/foo.ts: No errors found
```

| What you're doing | What gets injected |
|---|---|
| Reading a file | Crew status — who's working, any conflicts |
| About to edit a file | Crew locks for that file, lint/type errors, git context |
| After editing a file | Validation results (lint + type-check) on next tool call |
| Idle | Crew changes, git delta since last check |

This is automatic and deduplicated. You don't need to re-read the context file between edits.

---

## Crew: Multi-Agent Coordination

When multiple agents work the same repo, the **Crew Activity** block shows every active agent, their claimed files, and any conflicts.

### The rules

1. **Before editing a file, check the Crew Activity block.**
2. If you see `⚠️ CONFLICT` on a file — **stop**. Coordinate or pick different work.
3. Report your own work so others can see it:

```bash
pmd crew claim src/auth.ts --note "refactoring login"   # claim files you're editing
pmd crew note "running the test suite"                  # post your current task
pmd crew release src/auth.ts                            # release when done
pmd crew status                                         # see the whole crew
```

If edit hooks are installed (`pmd crew install-hooks`), claims happen automatically on every file edit. Sub-agents that need their own session call `pmd crew join --role worker` and export the printed `PMD_SESSION` value.

### Cross-machine crews

Agents can run on different machines, Docker containers, or cloud dev boxes. If the `crew` block shows entries tagged `· remote: <hostname>`, those agents are on a different machine — treat their claims the same as local ones.

---

## Link: Connecting Machines

`pmd link` connects PipeMD daemons across machines and Docker containers. One relay per machine, daemons poll it every 5 seconds.

```bash
pmd link                          # Start relay, get invite command
pmd link 192.168.1.42:9741        # Connect to a remote relay
pmd link --list                   # Show status and peers
pmd link --stop                   # Stop the relay
```

Docker containers connect via environment variables:

```bash
docker run -e PMD_RELAY=http://host.docker.internal:9741 -e PMD_GROUP=my-project ...
```

---

## Debugging & Tracing

```bash
pmd trace              # Live TUI — session tree, locks, injection timeline
pmd trace --locks      # File lock map only
pmd trace --timeline   # Injection event timeline
pmd trace --snapshot   # One-shot output (no watch)
pmd doctor             # Diagnose: daemon, config, scripts, hooks
pmd status             # Daemon PID, active pipes, recent logs
```

---

## CLI Reference

```bash
# Lifecycle
pmd init --headless               # Auto-detect everything, zero-interaction setup
pmd start                         # Start daemon (named pipes or file-watch)
pmd stop                          # Stop daemon
pmd restart                       # Restart (reloads config)
pmd status                        # Daemon health

# One-shot
pmd run                           # Render context to stdout (no daemon)
pmd run -o context.md             # Render to file

# Crew
pmd crew status                   # Show active sessions and conflicts
pmd crew claim <file>             # Claim a file
pmd crew release <file>           # Release a claim
pmd crew note "doing X"           # Post status
pmd crew install-hooks            # Wire harness hooks for auto-reporting

# Networking
pmd link                          # Start relay for cross-machine federation
pmd link <host:port>              # Connect to remote relay
pmd link --list                   # Show peers and status

# Debugging
pmd trace                         # Live crew resolution tree
pmd doctor                        # Full diagnostics
pmd refresh                       # Update bundled scripts
```

### Custom Init

```bash
pmd init --headless --harnesses OpenCode,"Claude Code"
pmd init --headless --ecosystem Python
pmd init --headless --scripts tree,git-status,deps,todos
pmd init --headless --delivery active
```

After `pmd init --headless`, check stdout for `PIPEDM_HEADLESS_RESULT=` — a JSON summary with `targetFiles`, `scripts`, `ecosystem`, and `profile`.

---

## Configuration Files

| File | Purpose |
|------|---------|
| `.pipemd/config.yml` | Scripts, pipes, token profile, target files, link config |
| `.pipemd/template.md` | `<!-- pmd: -->` block placement and section structure |
| `.pipemd/base.md` | Your editable rules and instructions (prepended to context) |
| `.pipemd/injection.yml` | Injection rules: triggers, sources, scopes (Active/Expert mode) |
| `.pipemd/scripts/` | Bash scripts that generate the live data |

### Harness Target Files

| Harness | Reads |
|---------|-------|
| OpenCode | `AGENTS.md` |
| Claude Code | `CLAUDE.md` |
| Gemini | `AI_CONTEXT.md` |
| Cursor | `.cursorrules` |
| Aider | `CONVENTIONS.md` |
| OpenClaw / Hermes | `WORKSPACE_CONTEXT.md` |

---

## Self-Improvement

You can tune this system over time:

- **Edit rules above `<!-- pmd-context -->`** to refine your own instructions
- **Reorder sections below `<!-- pmd-context -->`** to change context priority
- **Add/remove `<!-- pmd: -->` blocks** in `.pipemd/template.md` to control what data you see
- **Change token profile** in `.pipemd/config.yml` if context is too long or too short
- **Add custom scripts** in `.pipemd/config.yml` for project-specific data

The whole system is plain text in `.pipemd/`. You can edit any of it.
