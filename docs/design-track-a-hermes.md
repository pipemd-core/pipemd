# Track A Design — Hermes Adapter Architecture

> Spec for task `t_9b849006`. Produced by `empire-research`.
> Branch: `feat/hermes-network` · Base: `main` @ `c08d894`
> Scope: Track A only (Hermes integration). Track B (networking) is a separate spec.

This document specifies exact interfaces, file changes, and test structure for
implementing Hermes as a first-class PipeMD consumer. Every code signature below
is grounded in the actual source at commit `c08d894`; line references are to the
files listed in "Source audit". Where the source does not settle a question, it
is flagged under **Open questions** rather than invented.

---

## 0. Source audit (grounding)

| File | LOC | Role |
|---|---|---|
| `src/core/hooks.ts` | 73 | Adapter registry + `installHooks`/`removeHooks` dispatch |
| `src/core/opencode-hooks.ts` | 195 | "plugin" adapter — writes `.opencode/plugin/*` (the pattern to follow) |
| `src/core/claude-hooks.ts` | 90 | "hook" adapter — JSON hooks via `installJsonHooks` |
| `src/core/gemini-hooks.ts` | 62 | "hook" adapter — same pattern, minimal |
| `src/core/hook-utils.ts` | 188 | `HookEntry`, `installJsonHooks`, `stripPmdHooksFromSettings` |
| `src/core/detectHarness.ts` | 267 | `HARNESS_TARGETS`, `detectHermes()`, `needsLegacyMode` |
| `src/core/crew.ts` | 306 | Crew session model, `joinSession`, `CrewSession` schema |
| `src/commands/crew.ts` | 300 | `pmd crew` CLI: join/claim/note/status/render/... |
| `src/core/crew-render.ts` | 219 | `renderCrewBlock`, `getStatusJson` — harness-agnostic |
| `src/core/pipe-manager.ts` | 323 | `createPipe` (mkfifo), `serveContextPipe`, `resolvePipePath` |
| `src/core/daemon.ts` | 222 | pipe-mode vs legacy-mode branch (lines 157-183) |
| `src/core/injection-types.ts` | 335 | `DeliveryMode`, `InjectionTrigger`, validation |
| `src/commands/init/scaffold.ts` | 713 | `runInit` — builds `config.pipes`, `harnessNeedsLegacy` |
| `src/config.ts` | 37 | `PipeConfig`, `PipeMode` |

### Key facts that shape the design

1. **Hermes has no edit-event hook system.** Unlike Claude/Gemini (settings JSON
   hooks) and OpenCode (loadable plugin JS), Hermes exposes only: a **skills
   system** (SKILL.md + `skill_view`), a **terminal tool**, and ordinary file
   reads. There is no `BeforeTool`/`PreToolUse` interception point. → The Hermes
   "adapter" cannot install edit-event hooks; its `installHooks` deploys
   Hermes-side artifacts (the context-serving pipe registration + a skill) and
   its `mechanism` is `"skill+pipe"`, not `"hook"` or `"plugin"`.

2. **`WORKSPACE_CONTEXT.md` is already a registered target.** `detectHarness.ts`
   line 32: `HARNESS_TARGETS["Hermes"] = "WORKSPACE_CONTEXT.md"`. And
   `scaffold.ts` `runInit` (lines 466-471) already unshifts a
   `{ file: targetFile, render: ".pipemd/template.md", mode }` pipe entry for
   every selected harness. So **pipe registration for Hermes needs no new
   scaffold code** — it is produced automatically by `pmd init --harness Hermes`.
   The only scaffold change is the *mode* (see §2.3).

3. **The crew CLI already supports non-interactive registration.** `pmd crew join`
   (crew.ts lines 87-116) accepts `--role`, `--label`, `--harness`, `--coordinator`,
   `--sources`; `joinSession` (crew.ts core lines 221-281) also honors
   `PMD_CREW_ROLE` and `PMD_CREW_COORDINATOR` env vars. → A.2 ("ensure CLI
   supports non-interactive registration") is **already satisfied**; no crew CLI
   change is required. A bridge file is still useful to give the Hermes skill a
   stable shell entrypoint (see §3).

4. **`crew-render.ts` is harness-agnostic.** `buildCrewLines` (lines 103-167)
   renders any coordinator as `▸ <harness> (coordinator <id> · pid <n>)` and
   stamps remote sessions with `· remote: <origin>`. A Hermes coordinator will
   render correctly with zero render changes.

5. **Pipe vs legacy mode is decided per-pipe in the daemon** (daemon.ts lines
   157-183): `pipeModePipes` = pipes with `mode: "pipe"`, or no `mode` when
   `mkfifo` is available; `legacyModePipes` = `mode: "legacy"`, or no `mode`
   when `mkfifo` is absent. Legacy mode rewrites the file on disk via chokidar
   (legacy-watcher.ts); pipe mode serves a mkfifo FIFO.

6. **Hermes is currently forced to legacy mode** in two places:
   - `scaffold.ts` `harnessNeedsLegacy()` (line 264-266): returns true for Hermes.
   - `detectHarness.ts` `detectHermes()` (line 251): `needsLegacyMode: true`.
   Track A switches Hermes to **pipe mode** to match the OpenCode/AGENTS.md
   mechanism (named pipe for the context file). See §2.3 for the reconciliation.

---

## 1. `src/core/hermes-hooks.ts` — adapter interface

### 1.1 Rationale

The OpenCode adapter (`opencode-hooks.ts`) is the correct template — not the
Claude/Gemini JSON-hook adapters — because, like Hermes, OpenCode is served via
an artifact the adapter installs (a plugin file) rather than a settings-hooks
blob. For Hermes the installed artifacts are:

- the **context pipe** (`WORKSPACE_CONTEXT.md`) — actually registered by the
  scaffold, but the adapter confirms/reconciles it in `config.yml`;
- a **Hermes skill** (`pipemd-context`) written to `~/.hermes/skills/devops/` —
  gives Hermes an on-demand `pmd run` fetch path independent of the pipe.

`installHooks` therefore returns `mechanism: "skill+pipe"` and never reports
edit-event injection. `injectionMode` is left `undefined` (Hermes has no active
injection); this mirrors how the opencode adapter only sets `injectionMode` when
delivery is `active`/`expert`.

### 1.2 Exact interface

```ts
// src/core/hermes-hooks.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { DeliveryMode } from "./injection-types.js";
import type { HookInstallResult, HarnessAdapter } from "./hooks.js";
import { log, errMsg } from "./logger.js";

const SKILL_NAME = "pipemd-context";
const SKILL_CATEGORY = "devops";            // ~/.hermes/skills/devops/pipemd-context/
const TARGET_FILE = "WORKSPACE_CONTEXT.md"; // matches HARNESS_TARGETS["Hermes"]

/** Marker written into the skill frontmatter so removeHooks can detect our install. */
const PMD_MARKER = "<!-- pipemd-managed-skill -->";

/**
 * Skill body. Kept inline (not a separate template file) because it is the only
 * Hermes-specific artifact and is small. The skill instructs the Hermes agent to
 * read WORKSPACE_CONTEXT.md for passive context and to run `pmd run` for a
 * fresh, on-demand render. See §4.1 for the full skill content.
 */
function skillBody(): string { /* ...see §4.1... */ }

function hermesSkillsDir(): string {
  return path.join(os.homedir(), ".hermes", "skills", SKILL_CATEGORY);
}

function skillPath(): string {
  return path.join(hermesSkillsDir(), SKILL_NAME, "SKILL.md");
}

function installHermesHooks(
  cwd: string = process.cwd(),
  _delivery: DeliveryMode = "passive",
  dryRun: boolean = false,
  force: boolean = false,
): HookInstallResult {
  const results: string[] = [];
  let changed = false;

  // (1) Deploy / update the pipemd-context skill.
  const sPath = skillPath();
  const body = skillBody();
  const exists = fs.existsSync(sPath);
  if (!exists || force) {
    if (!dryRun) {
      fs.mkdirSync(path.dirname(sPath), { recursive: true });
      fs.writeFileSync(sPath, body, "utf-8");
    }
    changed = true;
    results.push(exists ? "skill: updated" : "skill: installed → ~/.hermes/skills/devops/pipemd-context");
  } else {
    results.push("skill: already installed");
  }

  // (2) Reconcile the WORKSPACE_CONTEXT.md pipe entry in config.yml.
  //     The scaffold already adds it on `pmd init`; this is idempotent insurance
  //     for projects that ran init before the adapter existed, and it normalizes
  //     the mode to "pipe" (see §2.3).
  const cfgPath = path.join(cwd, ".pipemd", "config.yml");
  // ... read YAML, ensure pipes contains { file: TARGET_FILE, render: ".pipemd/template.md", mode: "pipe" } ...
  // (implementation mirrors updateConfigInjected in scaffold.ts lines 395-445)
  results.push("config: WORKSPACE_CONTEXT.md pipe ensured (mode: pipe)");

  return {
    harness: "Hermes",
    installed: !dryRun && changed,
    mechanism: "skill+pipe",
    detail: (dryRun && changed ? "needs update: " : "") + results.join(" · "),
    // injectionMode intentionally undefined — Hermes has no active injection.
  };
}

function removeHermesHooks(_cwd: string): HookInstallResult {
  const sPath = skillPath();
  let removed = false;
  try {
    const content = fs.readFileSync(sPath, "utf-8");
    if (content.includes(PMD_MARKER)) {
      fs.unlinkSync(sPath);
      // best-effort: prune the now-empty skill dir
      try { fs.rmSync(path.dirname(sPath), { recursive: true }); } catch (err: unknown) { log.debug(`prune skill dir: ${errMsg(err)}`); }
      removed = true;
    }
  } catch (err: unknown) { log.debug(`removeHermesHooks skill unlink: ${errMsg(err)}`); }

  return {
    harness: "Hermes",
    installed: removed,
    mechanism: "skill+pipe",
    detail: removed ? "skill removed from ~/.hermes/skills/devops/pipemd-context" : "nothing to remove",
  };
}

export const hermesAdapter: HarnessAdapter = {
  name: "Hermes",
  installHooks: installHermesHooks,
  removeHooks: removeHermesHooks,
};
```

### 1.3 Conformance to `HarnessAdapter`

The adapter satisfies `hooks.ts` lines 15-19 exactly:

- `name: "Hermes"` — must equal the `adapters` map key and the
  `INSTRUCTION_ONLY` entry being removed (§2.1).
- `installHooks(cwd, delivery, dryRun, force)` — full signature; `delivery` is
  accepted but inert (no injection), matching the reality that Hermes is
  passive-only.
- `removeHooks(cwd)` — full signature; removes only skills we stamped, so it
  never clobbers a user-authored skill of the same name.
- Returns `HookInstallResult` (`hooks.ts` lines 7-13): `harness`, `installed`,
  `mechanism`, `detail`, optional `injectionMode`.

### 1.4 Why not `installJsonHooks`

`claude-hooks.ts` and `gemini-hooks.ts` both call
`installJsonHooks({ file, harness, hooks, ... })` (hook-utils.ts line 110) to
inject `pmd crew` / `pmd inject` shell commands into a settings JSON under a
`hooks` object. Hermes has no such settings file and no tool-event dispatch —
calling `installJsonHooks` would write a JSON blob nothing reads. The Hermes
adapter therefore does its own file I/O, exactly as `opencode-hooks.ts` does
(its `installOpenCodeHooks` never calls `installJsonHooks`).

---

## 2. `src/core/hooks.ts` changes

Two surgical edits. Both are required for `installHooks("Hermes", ...)` to
dispatch to `hermesAdapter` instead of the instruction-only no-op.

### 2.1 Register the adapter (lines 1-25)

Add the import and map entry:

```diff
 import { claudeAdapter } from "./claude-hooks.js";
 import { geminiAdapter } from "./gemini-hooks.js";
 import { opencodeAdapter } from "./opencode-hooks.js";
+import { hermesAdapter } from "./hermes-hooks.js";
 import { errMsg } from "./logger.js";
...
 const adapters: Map<string, HarnessAdapter> = new Map([
   ["Claude Code", claudeAdapter],
   ["OpenCode", opencodeAdapter],
   ["Gemini", geminiAdapter],
+  ["Hermes", hermesAdapter],
 ]);
```

`installHooks` (line 45) already does `adapters.get(harness)` first and only
falls through to `INSTRUCTION_ONLY` if no adapter is found — so registering the
adapter is sufficient for dispatch. The `if (INSTRUCTION_ONLY.includes(harness))`
branch (lines 49-56) becomes unreachable for Hermes once 2.2 is done.

### 2.2 Remove Hermes from `INSTRUCTION_ONLY` (line 35)

```diff
-const INSTRUCTION_ONLY = ["Cursor", "Aider", "OpenClaw", "Hermes", "OS Agent"];
+const INSTRUCTION_ONLY = ["Cursor", "Aider", "OpenClaw", "OS Agent"];
```

This is belt-and-suspenders: with the adapter registered, the lookup hits the
map and never reaches the `INSTRUCTION_ONLY` branch. Removing the entry prevents
a future reader from assuming Hermes is still instruction-only, and it ensures
that if the adapter import ever fails to load, `installHooks("Hermes")` returns
`mechanism: "unknown"` (an explicit error) rather than a silent instruction
no-op. `Cursor`, `Aider`, `OpenClaw`, `OS Agent` remain instruction-only.

### 2.3 Switch Hermes to pipe mode (cross-file consistency)

Hermes is currently forced to **legacy** mode in two spots. Track A wants the
**pipe** (mkfifo) mechanism, identical to OpenCode/AGENTS.md. Change both:

```diff
// src/commands/init/scaffold.ts  (harnessNeedsLegacy, lines 264-266)
 function harnessNeedsLegacy(name: HarnessName): boolean {
-  return name === "Cursor" || name === "OpenClaw" || name === "Hermes" || name === "OS Agent";
+  return name === "Cursor" || name === "OpenClaw" || name === "OS Agent";
 }
```

```diff
// src/core/detectHarness.ts  (detectHermes, line 251)
   return {
     name: "Hermes",
     targetFile: HARNESS_TARGETS["Hermes"],
     detected: signals.length > 0,
     signals,
-    needsLegacyMode: true,
+    needsLegacyMode: false,
   };
```

Effect: `pmd init --harness Hermes` now writes the `WORKSPACE_CONTEXT.md` pipe
with `mode: "pipe"`. The daemon (daemon.ts lines 157-163) routes it to
`runPipeMode` → `createPipe` (mkfifo, chmod 0o600) → `serveContextPipe`, which
re-renders `.pipemd/template.md` and writes the cache to the FIFO on
`reServeDelayMs` (default 1s). If `mkfifo` is unavailable, the daemon's
`!hasMkfifo` fallback (lines 165-169) silently demotes Hermes to legacy — no
extra code needed.

> **Open question OQ-1 (verify during implementation):** whether Hermes' file
> readers successfully consume a mkfifo FIFO. `cat WORKSPACE_CONTEXT.md` works
> (blocks until the daemon opens the write end, then streams the cached render).
> The risk is a synchronous `fs.readFileSync`-style reader that blocks the
> agent's loop or times out. A.1 step 4 ("Verify: `pmd init --harness Hermes`
> creates the pipe and template") must empirically confirm a Hermes `read_file`
> of the FIFO returns content, not a hang. If it hangs, the fallback is to keep
> `mode: "legacy"` for Hermes (daemon rewrites the file on disk; Hermes reads a
> normal file). The adapter, skill, and hook-registration changes are valuable
> either way; only the mode flag flips. See §6.

---

## 3. Hermes crew coordinator design (A.2)

### 3.1 What already works

- **Registration**: `pmd crew join --role coordinator --label "Hermes-Orchestrator" --harness Hermes`
  is fully supported today (crew.ts lines 87-116). It calls `joinSession`, which
  writes `~/.pipemd/crew/cr_<hex>.json` with `role: "coordinator"`,
  `harness: "Hermes"`, the caller's pid/ppid (from `resolveAgentIdentity`).
- **Visibility**: `renderCrewBlock` lists the coordinator as
  `▸ Hermes  (coordinator cr_xxx · pid xxxx)` with no render change needed.
- **File claims**: `pmd crew claim <files> --note "..."` marks files; conflicts
  surface in `findConflicts` and render as `⚠️ CONFLICT: <path> claimed by ...`.
- **Liveness**: the crew reap interval (30s, daemon.ts line 133) reaps stale
  Hermes sessions via heartbeat staleness + `isPidAlive`.

### 3.2 What is genuinely new: `src/core/hermes-crew-bridge.ts`

The CLI already does everything, but the Hermes *skill* should not assemble
shell strings inline. Provide a ~60-LOC thin bridge that the skill sources /
calls, so the skill body stays declarative and the command surface is testable.

```ts
// src/core/hermes-crew-bridge.ts — NOT a hook adapter; a shell-entry helper.
// Hermes invokes these via the terminal tool inside the pipemd-context skill.
// Each function prints a single line for the agent to parse.

import { execFileSync } from "node:child_process";
import { errMsg } from "./logger.js";

function pmd(args: string[]): string {
  try {
    return execFileSync("pmd", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
  } catch (err: unknown) {
    return `error: ${errMsg(err)}`;
  }
}

/** Hermes registers as coordinator for the current project. */
export function registerCoordinator(label = "Hermes-Orchestrator"): string {
  return pmd(["crew", "join", "--role", "coordinator", "--label", label, "--harness", "Hermes"]);
}

/** Claim files so coding agents see ownership and avoid conflicts. */
export function claimFiles(files: string[], note?: string): string {
  const args = ["crew", "claim", ...files];
  if (note) args.push("--note", note);
  return pmd(args);
}

/** Refresh liveness; the daemon reaps stale sessions at 30s + DEFAULT_STALE_MS. */
export function heartbeat(): string { return pmd(["crew", "heartbeat"]); }

/** Print the rendered crew block (what coding agents see in their context file). */
export function crewStatus(): string { return pmd(["crew", "render"]); }

/** Leave the crew (end of session). */
export function leave(): string { return pmd(["crew", "leave"]); }
```

> **Note:** this bridge is optional sugar. An equally valid implementation puts
> the raw `pmd crew ...` commands directly in the skill body (§4.1). Choose one;
> do not ship both. Recommendation: ship the bridge — it makes the skill body
> short and gives `tests/test-hermes-hooks.ts` a unit-testable surface (§5.3).

### 3.3 Remote coordinator visibility (depends on Track B)

For a Hermes coordinator on exoserver to appear in an OpenCode crew block on the
workstation, the relay must broadcast crew sessions (Track B.3). Track A lands
the **local** coordinator behavior; the `_remote` / `_origin` plumbing already
exists in `CrewSession` (crew.ts lines 36-37) and in `renderCrewBlock`
(remote badge, crew-render.ts line 135), so Track B needs no schema change to
surface Hermes remotely — only relay broadcast + `setRemoteSessions` wiring.

---

## 4. Hermes skill design

Two skills, both under `~/.hermes/skills/devops/`. Only `pipemd-context` is
installed by the adapter (§1.2); `pipemd-control` (A.3 daemon orchestrator) is
authored once and lives in the Empire's Hermes profile — it is operator tooling,
not per-project state.

### 4.1 `pipemd-context` (context consumer + crew coordinator)

Installed by `hermesAdapter.installHooks` to
`~/.hermes/skills/devops/pipemd-context/SKILL.md`. Body used by `skillBody()`
in §1.2:

```markdown
---
name: pipemd-context
description: PipeMD context for Hermes. Read WORKSPACE_CONTEXT.md for live project
  context, register as a crew coordinator, and claim files you are managing so
  coding agents (OpenCode/Claude) avoid edit conflicts.
version: 1.0.0
metadata:
  pipemd-managed: true
---

# PipeMD Context (Hermes)

This project is PipeMD-enabled. PipeMD renders live project context (git state,
architecture map, crew status, file errors) into `WORKSPACE_CONTEXT.md`.

## Passive context
- `WORKSPACE_CONTEXT.md` is a named pipe kept fresh by the PipeMD daemon.
- Read it with the terminal tool: `cat WORKSPACE_CONTEXT.md` (prefer this over
  read_file on the FIFO — see note below).
- It contains `<!-- pmd: <id> --> ... <!-- /pmd -->` blocks populated by the
  daemon. Treat their contents as read-only ground truth.

## On-demand fresh render
- `pmd run` re-renders the full context immediately and prints it to stdout.
- Use this when the pipe read looks stale or you need a guaranteed-fresh snapshot.

## Crew coordination
Register as a coordinator so coding agents see you and respect your file claims:
  pmd crew join --role coordinator --label "Hermes-Orchestrator" --harness Hermes
Export the returned session id for stable identity across calls:
  export PMD_SESSION=cr_<id>
Claim files you are managing:
  pmd crew claim path/to/file --note "refactoring auth"
See everyone:
  pmd crew render
Refresh liveness at least every 60s during long work:
  pmd crew heartbeat
Leave when done:
  pmd crew leave

## Note on reading the FIFO
`WORKSPACE_CONTEXT.md` is a mkfifo. `cat` is the safe reader. If a synchronous
read_file hangs, fall back to `pmd run`.
<!-- pipemd-managed-skill -->
```

The trailing `<!-- pipemd-managed-skill -->` is `PMD_MARKER` (§1.2): only skills
carrying it are removed by `removeHermesHooks`, so a user-authored skill of the
same name is never destroyed.

### 4.2 `pipemd-control` (daemon orchestrator — A.3)

Authored at `~/.hermes/skills/devops/pipemd-control/SKILL.md` (operator-owned,
not installed per-project). Backed by `~/.hermes/scripts/pipemd-health-check.sh`.
Surface:

| Action | Local command | Remote (workstation .73) |
|---|---|---|
| start | `pmd start` | `ssh ivann@192.168.1.73 'cd <proj> && pmd start'` |
| stop | `pmd stop` | `ssh ivann@192.168.1.73 'pmd stop'` |
| status | `pmd status` | `ssh ivann@192.168.1.73 'pmd status'` |
| restart | `pmd restart` | `ssh ivann@192.168.1.73 'pmd restart'` |

Skill body instructs the Hermes agent to:
1. prefer local `pmd <verb>`; for remote, prefix the SSH host from the Empire
   topology memory (exoserver .72 / workstation .73);
2. on failure, read `.pipemd/daemon.log` on the target machine;
3. emit a Telegram alert to the Empire watchdog topic only if a daemon is down
   for >2 consecutive checks.

### 4.3 Health-check cron (A.3)

- Script `~/.hermes/scripts/pipemd-health-check.sh`: `curl -sf http://<host>:<port>/health`
  per known daemon (peers from `~/.pipemd/peers.yml`, Track B.4). Exits non-zero
  with a one-line stderr message when a daemon is unhealthy; silent (exit 0,
  empty stdout) when all healthy — the watchdog-quiet pattern.
- Cron: every 5 min, `no_agent: true`, delivers the script's stdout verbatim.
  Because the script is silent when healthy, the cron only surfaces real
  outages.

> **Open question OQ-2:** the `/health` endpoint does not exist yet — it is
> Track B.1 deliverable (`relay.ts`). Track A's health-check skill can be
> authored and the cron created, but it will no-op until B.1 ships `/health`.
> Gate the cron behind B.1, or have the script fall back to `pmd status` exit
> codes in the interim.

---

## 5. Test file structure — `tests/test-hermes-hooks.ts`

Follows the established `node:test` + `node:assert/strict` pattern (see
`tests/test-crew.ts`). Same `before`/`after` tmpdir + chdir scaffold.

### 5.1 Skeleton

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { hermesAdapter } from "../src/core/hermes-hooks.js";
import { installHooks, removeHooks } from "../src/core/hooks.js";
import type { HookInstallResult } from "../src/core/hooks.js";

let tmpDir: string;
let origCwd: string;
let origHome: string;

before(() => {
  origCwd = process.cwd();
  origHome = process.env.HOME!;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-hermes-test-"));
  // minimal PipeMD project so config reconciliation has a target
  fs.mkdirSync(path.join(tmpDir, ".pipemd"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, ".pipemd", "config.yml"), 'version: "1.0"\n');
  process.chdir(tmpDir);
  // redirect HOME so the skill is written under the temp dir, not the real profile
  const fakeHome = path.join(tmpDir, "fake-home");
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
});

after(() => {
  process.env.HOME = origHome;
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

### 5.2 Test cases

```ts
describe("hermesAdapter", () => {
  it("installHooks writes the pipemd-context skill under HOME/.hermes/skills", () => {
    const r = hermesAdapter.installHooks(tmpDir, "passive", false, true);
    assert.equal(r.harness, "Hermes");
    assert.equal(r.mechanism, "skill+pipe");
    assert.equal(r.installed, true);
    const skill = path.join(process.env.HOME!, ".hermes", "skills", "devops", "pipemd-context", "SKILL.md");
    assert.ok(fs.existsSync(skill), "skill file should exist");
    assert.ok(fs.readFileSync(skill, "utf-8").includes("<!-- pipemd-managed-skill -->"));
  });

  it("installHooks is idempotent (re-install reports already-installed, no error)", () => {
    hermesAdapter.installHooks(tmpDir, "passive", false, true);
    const r = hermesAdapter.installHooks(tmpDir, "passive", false, false); // force=false
    assert.equal(r.installed, false);
    assert.match(r.detail, /already installed/);
  });

  it("dryRun does not write files but reports needs-update", () => {
    // point HOME at a fresh empty home
    const fresh = path.join(tmpDir, "fresh-home"); fs.mkdirSync(fresh, { recursive: true });
    process.env.HOME = fresh;
    const r = hermesAdapter.installHooks(tmpDir, "passive", true, true);
    assert.equal(r.installed, false);
    assert.match(r.detail, /needs update/);
    assert.ok(!fs.existsSync(path.join(fresh, ".hermes")));
  });

  it("installHooks ensures WORKSPACE_CONTEXT.md pipe entry in config.yml with mode: pipe", () => {
    hermesAdapter.installHooks(tmpDir, "passive", false, true);
    const cfg = fs.readFileSync(path.join(tmpDir, ".pipemd", "config.yml"), "utf-8");
    assert.match(cfg, /WORKSPACE_CONTEXT\.md/);
  });

  it("removeHooks deletes only pipemd-managed skills", () => {
    hermesAdapter.installHooks(tmpDir, "passive", false, true);
    const r = hermesAdapter.removeHooks(tmpDir);
    assert.equal(r.installed, true);
    const skill = path.join(process.env.HOME!, ".hermes", "skills", "devops", "pipemd-context", "SKILL.md");
    assert.ok(!fs.existsSync(skill));
  });

  it("removeHooks is a no-op when no managed skill is present", () => {
    const r = hermesAdapter.removeHooks(tmpDir);
    assert.equal(r.installed, false);
    assert.match(r.detail, /nothing to remove/);
  });

  it("removeHooks leaves a user-authored skill of the same name untouched", () => {
    const skillDir = path.join(process.env.HOME!, ".hermes", "skills", "devops", "pipemd-context");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"),
      "---\nname: pipemd-context\n---\nuser content, no marker\n");
    const r = hermesAdapter.removeHooks(tmpDir);
    assert.equal(r.installed, false);
    assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md")), "user skill must survive");
  });
});

describe("hooks.ts dispatch for Hermes", () => {
  it("installHooks('Hermes') dispatches to the adapter (not instruction-only)", () => {
    const r = installHooks("Hermes", tmpDir, "passive", false, true) as HookInstallResult;
    assert.equal(r.harness, "Hermes");
    assert.notEqual(r.mechanism, "instruction"); // proves INSTRUCTION_ONLY removal
    assert.equal(r.mechanism, "skill+pipe");
  });

  it("removeHooks('Hermes') dispatches to the adapter", () => {
    const r = removeHooks("Hermes", tmpDir) as HookInstallResult;
    assert.equal(r.harness, "Hermes");
  });
});
```

### 5.3 Bridge tests (optional, only if §3.2 ships)

`tests/test-hermes-crew-bridge.ts` — stub `execFileSync` (or set `PATH` to a
fake `pmd` that echoes args) and assert each bridge function issues the correct
`pmd crew ...` argv. Keep these isolated from the hook tests; they do not need a
PipeMD project because the bridge is a pure shell wrapper.

### 5.4 What NOT to test here

- mkfifo creation / FIFO read semantics — that is `pipe-manager.ts`'s domain
  (already covered by daemon tests) and is environment-dependent. The mkfifo
  read robustness for Hermes is verified manually in A.1 step 4 (OQ-1).
- Relay broadcast / remote crew visibility — Track B.3 tests
  (`tests/test-crew-broadcast.ts`).

---

## 6. Open questions (flagged, not invented)

- **OQ-1 — mkfifo read from Hermes (BLOCKER for pipe mode).** Does a Hermes
  `read_file` of `WORKSPACE_CONTEXT.md` (a FIFO) return the served content, or
  hang/timeout? Must be verified empirically in A.1 step 4 before flipping
  Hermes to `mode: "pipe"` (§2.3). If it hangs, keep Hermes on `mode: "legacy"`
  (daemon writes a real file; Hermes reads normally) and drop the
  pipe-mode claim. The adapter, skills, and crew bridge are valuable either way.
  Mitigation already in the skill body (§4.1): instruct the agent to prefer
  `cat` and fall back to `pmd run`.

- **OQ-2 — `/health` endpoint missing.** `pipemd-control`'s health-check relies
  on `GET /health` (Track B.1). Until B.1 ships, the check must fall back to
  `pmd status` exit codes. Gate the cron behind B.1.

- **OQ-3 — `WORKSPACE_CONTEXT.md` target collision.** `HARNESS_TARGETS` maps
  both `OpenClaw` and `Hermes` (and `OS Agent` fallback) to the same file. In a
  project that initializes both, the scaffold unshifts duplicate pipe entries.
  This is benign (one FIFO, served once) but `updateConfigInjected`'s dedup
  (scaffold.ts lines 408-420) keys on `render === ".pipemd/template.md"`, so the
  second harness's entry is dropped — meaning only the first harness's `mode`
  wins. Confirm whether mixing Hermes + OpenClaw in one project is a real Empire
  scenario; if so, the dedup must preserve per-harness mode (currently it does
  not). Not a Track A deliverable unless the Empire uses both.

- **OQ-4 — skill install location vs profile.** The adapter writes the skill to
  `$HOME/.hermes/skills/devops/`. On the Empire, Hermes profiles live under
  `~/.hermes/profiles/<profile>/skills/`. If a worker profile (e.g.
  `empire-research`) should *not* receive the `pipemd-context` skill, the
  adapter may need to target the profile that actually runs coding/coordination
  work. Confirm the intended install path with the operator before
  hard-coding `$HOME/.hermes/skills/devops/`. (The plan text uses that path, so
  this spec follows it, but it is worth a sanity check.)

---

## 7. Implementation order (for empire-dev, task T3)

1. `tests/test-hermes-hooks.ts` (§5) — RED first.
2. `src/core/hermes-hooks.ts` (§1.2) — GREEN against the tests.
3. `src/core/hooks.ts` edit (§2.1, §2.2) — the dispatch tests turn GREEN.
4. `src/commands/init/scaffold.ts` + `src/core/detectHarness.ts` mode flip (§2.3).
5. Manual verify OQ-1: `pmd init --harness Hermes` in a scratch repo,
   `cat WORKSPACE_CONTEXT.md` returns rendered context. If hang → revert §2.3 to
   legacy, leave everything else.
6. `src/core/hermes-crew-bridge.ts` (§3.2) + `tests/test-hermes-crew-bridge.ts`.
7. Author `pipemd-context` SKILL.md content into `skillBody()` (§4.1).
8. Author `pipemd-control` SKILL.md + health-check script (§4.2/§4.3), gated on
   B.1 for the cron.
9. Commit on `feat/hermes-network`.

## 8. Risks (carried from plan + source-derived)

- **Relay freeze was deliberate** — Track B only; Track A does not touch
  `relay.ts`, so this risk does not block Track A.
- **mkfifo fragility for LLM file readers** — OQ-1; mitigated by skill guidance
  + legacy fallback.
- **Skill path/profile mismatch** — OQ-4; confirm with operator.
- **Two-machine testing** — Track A is single-machine (exoserver); cross-machine
  coordinator visibility is gated on Track B.3 and needs no Track A work beyond
  the schema already present.
