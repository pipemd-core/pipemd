# PipeMD ↔ Hermes Integration Notes

*Observations and requirements discovered during the feat/hermes-network development cycle.*

## What PipeMD Needs to Provide Hermes

### 1. Context Serving (solved by Track A)

Hermes has NO edit-event hooks (no PreToolUse, no BeforeToolCall). Unlike Claude/Gemini (settings JSON hooks) and OpenCode (loadable JS plugin), Hermes only has:
- Skills system (SKILL.md files loaded via `skill_view`)
- Terminal/file tools (read_file, terminal)
- Memory injection (MEMORY block in system prompt)

**Implication:** PipeMD cannot actively push context to Hermes. It can only:
- Serve a named pipe (`WORKSPACE_CONTEXT.md`) that Hermes reads via `read_file`
- Provide an on-demand `pmd run` command for fresh context
- Deploy a Hermes skill (`pipemd-context`) that wraps the `pmd run` call

This is already implemented in Track A (hermes-hooks.ts). The adapter deploys:
1. A mkfifo pipe at `WORKSPACE_CONTEXT.md`
2. A Hermes skill at `~/.hermes/skills/devops/pipemd-context/SKILL.md`

### 2. Crew Coordination (partially solved)

PipeMD's crew system lets agents announce their presence and claim files. The crew CLI already supports non-interactive registration via env vars (`PMD_CREW_ROLE`, `PMD_CREW_COORDINATOR`).

**What Hermes needs from PipeMD:**
- `pmd crew join --role coordinator --label "Hermes-Orchestrator"` — register as crew coordinator
- Crew block visible in WORKSPACE_CONTEXT.md — Hermes reads this via the pipe
- File claims — Hermes marks files it's managing so coding agents (opencode) don't clobber them
- Cross-machine crew broadcast (Track B) — Hermes on exoserver sees opencode agents on workstation

**Gap:** There's no Hermes-native crew command. The skill needs a `pmd crew` wrapper so Hermes can manage crew state via its terminal tool without remembering CLI flags.

### 3. Context Blocks Missing for Hermes Use Case

Current PipeMD blocks target coding agents. Hermes as an orchestrator needs different context:

| Block | Why Hermes needs it | Status |
|-------|---------------------|--------|
| `crew` | See active agents, their claims, what they're working on | Exists |
| `git-status` | Know what changed since last interaction | Exists |
| `git-log` | Review commit history for code review | Exists |
| `hotspots` | Identify churn-heavy files for review focus | Exists |
| `daemon-status` | Know if PipeMD daemon is alive, block count, peer status | **MISSING** — needs /health + /metrics data |
| `opencode-sessions` | What opencode agents are doing, their reports | **MISSING** — needs plugin bridge integration |
| `worktree-map` | What git worktrees exist, which branches | **MISSING** — needed for multi-track work |
| `empire-services` | Docker containers, system services, health checks | **MISSING** — Hermes-specific infra context |

### 4. Hermes Skill: pipemd-context (to deploy)

The skill should provide Hermes with:
```
pmd run                    → fresh context render to stdout
pmd crew status            → who's in the crew
pmd crew join              → register as coordinator
pmd crew claim <file>      → claim a file
pmd crew release <file>    → release a claim
pmd status                 → daemon health
pmd doctor                 → diagnose PipeMD issues
```

### 5. Hermes Skill: pipemd-control (to deploy)

For daemon lifecycle management across the Empire:
```
pmd start                  → local daemon start
pmd stop                   → local daemon stop
pmd restart                → local daemon restart
ssh workstation pmd status → remote daemon check (via Hermes terminal)
```

### 6. The Pipe Mode Issue

Hermes was originally forced to `legacy` mode (file rewritten on disk via chokidar watcher). Track A switches to `pipe` mode (mkfifo). But there's a subtlety:

- `read_file` in Hermes reads from disk. With mkfifo, the read blocks until the daemon writes.
- The daemon serves the pipe on a 1s delay (`reServeDelayMs`).
- If Hermes calls `read_file("WORKSPACE_CONTEXT.md")` and the daemon isn't ready, it may hang or get empty data.
- **Mitigation:** The Hermes skill should prefer `pmd run` (one-shot render to stdout) over reading the pipe directly. The pipe is for coding agents that read it in their tool loop.

## What the opencode-hermes Plugin Enables

The plugin bridges opencode → Hermes:
- `session.idle` → Hermes gets a structured report (no tmux attachment needed for review)
- `file.edited` → Hermes can track what the agent changed
- Future: custom tool `hermes:ask` → opencode queries Hermes for context mid-session

This creates the triangle:
```
PipeMD → context → Hermes (orchestrator)
Hermes → delegates → opencode (builder)
opencode → reports back → Hermes (via plugin)
```

## Open Issues for PipeMD Development

1. **Worktree-map block** — Hermes needs to know about git worktrees when managing multi-track development. No resolver exists.

2. **Opencode-session block** — Hermes needs to see active opencode sessions and their status. Could be fed by the hermes-bridge plugin's reports directory.

3. **Daemon-status block** — The /health and /metrics endpoints exist now (Track B), but there's no PipeMD block that surfaces this data in the context render. Need a `daemon-status` resolver that fetches `http://localhost:9741/health` and `http://localhost:9741/metrics`.

4. **Cross-machine context freshness** — When Hermes on exoserver reads context that originated on workstation (via block federation, Track B), there's no indication of staleness or origin. The crew block shows `_origin` but other blocks don't.

5. **Hermes skill auto-deployment** — The hermes-hooks.ts adapter deploys the skill, but `pmd init` doesn't run `installHooks` for Hermes (it was INSTRUCTION_ONLY). Now that the adapter is registered, `pmd init --harness Hermes` should trigger skill deployment. Need to verify the init flow actually calls installHooks for the selected harness.
