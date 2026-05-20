# PipeMD Context Reference

> This file explains how PipeMD context files work so AI agents can read, edit, and improve them effectively.

## How the Context File Works

PipeMD maintains a live context file (e.g. `AGENTS.md`, `CLAUDE.md`) that AI agents read for project information. The daemon refreshes `<!-- pmd: -->` blocks on every cycle with up-to-date data from bash scripts (tree, git status, deps, lint errors, etc.).

## File Structure

The context file has two zones separated by `<!-- pmd-context -->`:

```
┌─────────────────────────────────────┐
│  Base section (above separator)     │
│  ─ editable, routes to base.md      │
│  ─ rules, notes, instructions       │
├─────────────────────────────────────┤
│  <!-- pmd-context -->               │
├─────────────────────────────────────┤
│  Template section (below separator) │
│  ─ contains <!-- pmd: --> blocks    │
│  ─ editable outside those blocks    │
│  ─ edits route to template.md       │
└─────────────────────────────────────┘
```

### Edit Routing

| Where you edit | Where it persists |
|---|---|
| Above `<!-- pmd-context -->` | `.pipemd/base.md` |
| Below `<!-- pmd-context -->`, outside `<!-- pmd: -->` blocks | `.pipemd/template.md` via reverseInject |
| Inside `<!-- pmd: -->` blocks | **Nowhere** — overwritten every cycle |

## What You Can and Cannot Edit

**Can edit:**
- Rules, notes, and checkboxes above `<!-- pmd-context -->` — these persist in `base.md`
- Section headers, labels, and any content below `<!-- pmd-context -->` that is outside `<!-- pmd: -->` blocks — these persist in `template.md`

**Cannot edit:**
- Anything inside `<!-- pmd: ... -->` ... `<!-- /pmd -->` blocks — the daemon overwrites these on every refresh cycle. Your edits will be lost.

## Volatility and Cache Optimization

Content is ordered by volatility so that LLM Prompt Prefix Caching works efficiently:

| Volatility | Meaning | Examples |
|---|---|---|
| 1 | Rarely changes | `arch`, `tree`, `deps` |
| 2 | Changes on commit | `todos`, `git-log`, `git-branch`, `type-check` |
| 3 | Changes on file save | `git-status` |
| 4 | Changes continuously | `diff-stat` |

Stable content (volatility 1-2) goes in the **Project Context** section at the top. Rapidly changing content (volatility 3-4) goes in the **Volatile State** section at the bottom. This minimizes cache invalidation — the top portion stays identical across reads.

## Self-Improvement

You can improve this context file over time:

- **Edit rules above `<!-- pmd-context -->`** to refine your own instructions (persists in `base.md`)
- **Reorder or relabel sections below `<!-- pmd-context -->`** to change context priority (persists in `template.md`)
- **Add or remove `<!-- pmd: -->` blocks** in `.pipemd/template.md` to tune what data you receive
- **Adjust volatility** in `.pipemd/config.yml` to control cache stability
- **Change token profile** in `.pipemd/config.yml` if context is too long or too sparse
- **Add or remove scripts** in `.pipemd/config.yml` to change what data the daemon collects

## Working Alongside Other Agents (Crew)

If this project uses PipeMD Crew, a **Crew Activity** block appears in the
context file showing every agent currently working the repo, the files each
has claimed, and any conflicts. The coordination model is
**Harness → Coordinator → sub-agents** — one coordinator per harness, with
PipeMD as the neutral meta-coordinator that renders the union.

**Before editing a file, check the Crew Activity block.** A `⚠️ CONFLICT` line
means another agent has claimed a file you are about to touch — coordinate or
pick different work; treat it as blocking.

Report your own work so other agents see it:

```bash
pmd crew claim src/auth.ts --note "refactoring login"   # claim files you're editing
pmd crew note "running the test suite"                  # post your current task
pmd crew release src/auth.ts                            # release when done
pmd crew status                                         # see the whole crew
```

If edit hooks were installed (`pmd crew install-hooks`), claims happen
automatically on every file edit — no manual calls needed. Sub-agents that need
their own session call `pmd crew join --role worker` and export the printed
`PMD_SESSION` value.

## Smart Context Injection

If this project uses **Active** or **Expert** delivery mode, PipeMD installs hooks that inject fresh context into your working memory on every tool call. This means you don't need to re-read the context file to see updated state — the latest information is delivered to you automatically.

### What you'll see

On tool calls, you may see messages like:

```
[pmd:crew-locks → src/foo.ts]
File src/foo.ts: claimed by Claude Code (cr_abc123) 30s ago
```

```
[pmd:file-errors → src/foo.ts]
No known errors in src/foo.ts
```

```
[pmd:validate-file → src/foo.ts]
After your edit to src/foo.ts: No errors found
```

### When context is injected

| What you're doing | What gets injected |
|---|---|
| Reading a file | Crew status (who's working, any conflicts) |
| Editing a file | Crew locks for that file, lint/type errors for that file, git context |
| Just edited a file | Validation results (lint + type-check) on next tool call |
| Idle | Crew status changes, git delta |

### How to use this

- **Before editing**: check the injected crew locks. If a file is claimed by another agent, coordinate or pick different work.
- **After editing**: the validation result appears on your next tool call. If errors remain, fix them.
- **You don't need to do anything** — injection is automatic and deduplicated (unchanged data is skipped).

### Configuration

Injection rules live in `.pipemd/injection.yml`. In Active mode, sensible defaults are pre-configured. In Expert mode, you can customize triggers, sources, scopes, and limits.

## Configuration Files

| File | Purpose |
|---|---|
| `.pipemd/config.yml` | Daemon config: scripts, pipes, token profile, target files |
| `.pipemd/template.md` | Template with `<!-- pmd: -->` block placement and section structure |
| `.pipemd/base.md` | Your editable rules and instructions (prepended to served context) |
| `.pipemd/injection.yml` | Smart injection rules: triggers, sources, scopes (Active/Expert mode) |
| `.pipemd/scripts/` | Bash scripts that generate the live data |

## CLI Reference

```bash
pmd init --headless    # Auto-detect ecosystem, harnesses, scripts; configure everything
pmd start              # Start the daemon (serves context via named pipes or file-watch)
pmd stop               # Stop the daemon
pmd restart            # Restart (reloads config.yml)
pmd status             # Check if daemon is running
pmd run                # One-shot render to stdout (no daemon)
pmd refresh            # Sync bundled scripts; add newly available ones
pmd doctor             # Diagnose common issues
pmd inject --trigger before-edit --file src/foo.ts  # (internal) Resolve injection payloads for a trigger
pmd crew status        # Show agents currently coordinating on this repo
```

### Custom Init Options

```bash
pmd init --headless --harnesses OpenCode,"Claude Code"   # Override auto-detected harnesses
pmd init --headless --ecosystem Python                    # Force a specific ecosystem
pmd init --headless --scripts tree,git-status,deps,todos  # Pick specific scripts
```

## After Setup: Reading the Context

The target file depends on your harness:

| Harness | Target file |
|---|---|
| OpenCode | `AGENTS.md` |
| Claude Code | `CLAUDE.md` |
| Cursor | `.cursorrules` |
| Gemini | `AI_CONTEXT.md` |
| Aider | `CONVENTIONS.md` |
| OpenClaw / Hermes | `WORKSPACE_CONTEXT.md` |
| OS Agent (fallback) | `AGENTS.md` |

After `pmd init --headless`, look for `PIPEDM_HEADLESS_RESULT=` in stdout for a JSON summary with `targetFiles`, `scripts`, `ecosystem`, and `profile`.