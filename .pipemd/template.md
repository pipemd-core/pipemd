# 🏴‍☠️ Context — powered by PipeMD

> **🤖 PipeMD Context File**
>
> This file is maintained by PipeMD. It refreshes automatically.
>
> - Content inside `<!-- pmd: -->` blocks is **read-only** — the daemon overwrites it every cycle.
> - Everything else is **yours to edit**. Edits persist via bidirectional write-back.
> - Edits above `<!-- pmd-context -->` route to `.pipemd/base.md`. Edits below it route to `.pipemd/template.md`.
> - For full details, read `.pipemd/AI_SETUP_PIPEMD.md`.

*Stable content is at the top to maximize LLM Prompt Prefix Caching. Volatile data is at the bottom so it doesn't invalidate the cache.*

---

## Static Rules & Notes

- Content inside `<!-- pmd: -->` blocks is **read-only** — the daemon overwrites it every cycle. Never edit these.
- Content outside `<!-- pmd: -->` blocks is **yours** — edits persist via bidirectional write-back.
- PipeMD blocks refresh every few seconds. Trust them — they are cheaper and more current than running shell commands.
- If blocks are empty or stale, the daemon may be down. Check with `pmd status`.
- Active injection (`[pmd:…→` messages on tool calls) delivers fresh context automatically — you don't need to re-read the context file between edits.

### Agent Decision Tree

You are operating inside a PipeMD context file. The `<!-- pmd: -->` blocks below are live data refreshed by the daemon. This section defines your complete operating workflow — follow it for every task.

---

#### 1. Context Gathering — Read Before You Act

Before writing a single line of code, gather your bearings from the blocks below. They are your fastest, most accurate source of project truth.

| You need… | Read this block | Do NOT run |
|---|---|---|
| Project structure, find a file | `tree` | `tree`, `find`, `ls -R` |
| Architecture / module graph | `arch` | manual file inspection |
| Ranked symbol map, what's where | `repomap` | manual `grep` for exports |
| Dependencies and versions | `deps` | `cat package.json` |
| Known TODOs, FIXMEs, HACKs | `todos` | `grep -r TODO` |
| Exported symbols, env vars | `exports` | manual source scan |
| Recent commits (what changed) | `git-log` | `git log` |
| Current branch, tracking status | `git-branch` | `git status -b` |
| Changed / staged / untracked files | `git-status` | `git status` |
| Diff summary (+/- lines) | `diff-stat` | `git diff --stat` |
| Change hotspots (where bugs live) | `hotspots` | `git log --numstat` |
| Type errors | `type-check` | `tsc --noEmit` |
| Lint errors | `lint` | `eslint .` |
| Test pass/fail summary | `test-summary` | full test run |
| Crew: who's working, conflicts | `crew` | `pmd crew status` |
| DB models, routes, components | ecosystem-specific blocks | manual source scan |

If the answer isn't in the blocks — then (and only then) run the appropriate shell command. But check blocks first, always.

---

#### 2. Think Before You Code

Don't assume. Don't hide confusion. Surface tradeoffs before you type.

- **State your plan.** If the task is non-trivial, write a brief plan with verifiable checkpoints:
  ```
  1. [Step] → verify: [check]
  2. [Step] → verify: [check]
  3. [Step] → verify: [check]
  ```
- **Surface assumptions.** If multiple interpretations exist, present them — don't pick silently. If something is unclear, stop and ask.
- **Define success criteria.** Transform vague tasks into verifiable goals:
  - "Add validation" → "Write tests for invalid inputs, then make them pass"
  - "Fix the bug" → "Write a test that reproduces it, then make it pass"
  - "Refactor X" → "Ensure tests pass before and after"
- **Plan the smallest change.** Identify the exact feature, its source of truth, and its direct dependencies. No speculative features, no "while I'm here" refactors. If a simpler approach exists, say so.

---

#### 3. Coordinate — Multi-Agent & Crew Protocol

**If a `crew` block is present, you are not alone.** Other agents may be editing the same codebase simultaneously. Follow these rules to avoid conflicts and wasted work.

**Before editing any file:**

1. Read the `crew` block. It lists every active session, their claimed files, and any conflicts.
2. If the file is claimed by another agent (`⚠️ CONFLICT`), **stop**. Coordinate with that agent or pick different work. Treat conflicts as blocking.
3. If edit hooks are installed, claims happen automatically on every file edit. If not, claim manually:
   ```bash
   pmd crew claim src/auth.ts --note "refactoring login"
   ```
4. Post your intent so others can see it:
   ```bash
   pmd crew note "rewriting the auth middleware"
   ```

**Sub-agents and parallel workers:**

- PipeMD uses a **Harness → Coordinator → Worker** hierarchy. Each harness has one coordinator; workers are sub-agents spawned for parallel tasks.
- If you are a coordinator spawning sub-agents:
  - Each worker must `pmd crew join --role worker` and export `PMD_SESSION` to get its own session.
  - Partition work by file or directory to minimize overlap. Assign non-overlapping file sets.
  - Workers auto-detect their coordinator via process ancestry — no manual linking needed.
  - Monitor the `crew` block for conflicts between your workers. Resolve immediately.
- If you are a worker:
  - Your session is derived from your parent process. Claim only the files assigned to you.
  - Check the `crew` block before every edit, not just once at start.
  - Release files when done: `pmd crew release src/auth.ts`.

**Staleness and cleanup:**

- Sessions without a heartbeat for 90 seconds are considered stale. A fresh heartbeat always outranks a dead-PID guess.
- Clean up when you're done: `pmd crew leave` removes your session entirely.

**Cross-harness coordination:**

- PipeMD is harness-neutral. Claude Code, OpenCode, Gemini, Aider, and Cursor agents all share the same crew ledger.
- The `crew` block renders the union of all sessions — you see everyone, regardless of their harness.
- If you see a passive agent (listed but without a crew session), they may not have crew hooks installed. Their edits are uncoordinated — exercise extra caution around their files.

---

#### 4. Edit — Surgical Discipline

- **Match existing code style.** Imports, naming, formatting, conventions — follow what's already there. Don't impose your preferences.
- **One concern per edit.** If you spot unrelated issues, mention them but don't fix them unless asked.
- **Never bypass abstractions.** If a file is protected by a service or abstraction layer, use it. Don't modify the underlying file directly.
- **No logic duplication.** Don't duplicate logic or create parallel states if a source of truth already exists.
- **No speculative code.** No features beyond what was asked. No abstractions for single-use code. No error handling for impossible scenarios. If you write 200 lines and it could be 50, rewrite it.
- **Clean up only your own mess.** Remove imports, variables, and functions that your changes made unused. Don't touch pre-existing dead code.
- **Never edit inside `<!-- pmd: -->` blocks** — your changes are overwritten on the next daemon cycle.

---

#### 5. Verify — Close the Loop

Every change must be verified. Weak success criteria ("make it work") require constant clarification. Strong criteria let you loop independently.

- **Run the project's verification suite.** Check the rules above `<!-- pmd-context -->` or the `deps` block for the correct commands. Typical order: lint → typecheck → test → build.
- **Re-read the quality blocks.** After your edits, check `type-check` and `lint` blocks for new errors. If active injection is running, validation results appear automatically on your next tool call.
- **Verify blast radius.** Did your change affect anything beyond the intended scope? Re-read affected blocks to confirm.
- **Committing?** `git diff --cached` is the only git command you need — staged diffs are not provided by any block. Stage your files, review the diff, then commit.
- **Release claims.** When done with a file: `pmd crew release src/auth.ts`. When done entirely: `pmd crew leave`.

---

## Project Context

### Architecture Map

<!-- pmd: arch -->
```

```
<!-- /pmd -->

### Repo Map

<!-- pmd: repomap -->
```

```
<!-- /pmd -->

### Project Tree

<!-- pmd: tree -->
```

```
<!-- /pmd -->

### Dependencies

<!-- pmd: deps -->
```

```
<!-- /pmd -->

### TODOs / FIXMEs

<!-- pmd: todos -->
```

```
<!-- /pmd -->

### Exports & Env

<!-- pmd: exports -->
```

```
<!-- /pmd -->

### Lint Errors

<!-- pmd: lint -->
```

```
<!-- /pmd -->

### Test Summary

<!-- pmd: test-summary -->
```

```
<!-- /pmd -->

### Dead Code

<!-- pmd: dead-code -->
```

```
<!-- /pmd -->

### Crew Activity

<!-- pmd: crew -->
```

```
<!-- /pmd -->

---

## 🚨 Volatile State

*This section contains rapidly changing data. It is placed at the bottom to avoid invalidating the LLM Prompt Cache for the stable content above.*

### Git Status

<!-- pmd: git-status -->
```

```
<!-- /pmd -->

### Diff Stats

<!-- pmd: diff-stat -->
```

```
<!-- /pmd -->

### Recent Commits

<!-- pmd: git-log -->
```

```
<!-- /pmd -->

### Branch & Tracking

<!-- pmd: git-branch -->
```

```
<!-- /pmd -->

### Type Errors

<!-- pmd: type-check -->
```

```
<!-- /pmd -->

### Churn Hotspots

<!-- pmd: hotspots -->
```

```
<!-- /pmd -->

### Timestamp

<!-- pmd: now -->
```

```
<!-- /pmd -->

<!-- pmd: git-context -->
```

```
<!-- /pmd -->
