# PipeMD Roadmap

*Last updated: 2026-05-26*

> **PipeMD is a context provider. Its job: resolve fresh, relevant context and push it to AI agents faster than anything else.**

## The Product

The injection engine IS the product. Named-pipe PUSH (sub-ms, kernel-level). Hook-based active injection on every tool call. Bidirectional write-back. Everything else exists to feed or deliver that engine.

The moat: cross-harness, sub-ms context delivery via named pipes. No other tool does this.

## Scorecard

| Phase | Exit Criterion | Status |
|-------|---------------|--------|
| **0. Stabilize** | Zero dead resolvers. Zero broken resolvers. Every default rule produces non-empty output in the happy path. | **In Progress** |
| **1. Trim** | Remove every LOC that doesn't produce or deliver context. MCP server is read-only. Task CLI gone. | Planned |
| **2. Harden** | Every default rule produces fresh, relevant context for solo + crew agents. Ecosystem-aware syntax checking. Per-resolver timeouts. | Planned |
| **3. Inter-Harness** | Two different harnesses on the same machine share context seamlessly via relay. | Planned |
| **4. Network** | Multi-machine relay. Context sharing, not orchestration. Gated on Phases 0-3 being perfect. | Paused |

---

## Current State: Honest Inventory

### Codebase (10,525 LOC)

| Concern | LOC | Verdict |
|---|---|---|
| Block rendering / injection pipeline | 2,090 | **The product. Keep.** |
| Hook adapters (Claude/Gemini/OpenCode) | 686 | **Delivery mechanism. Keep.** |
| Daemon lifecycle | 367 | **Keep.** |
| Detection (ecosystem/harness) | 632 | **Keep.** |
| Tracing / dashboard | 662 | Debug tooling. Shrink. |
| Statusline | 153 | Keep. |
| Utilities | 142 | Keep. |
| Crew sessions | 706 | Split — claim/lock IS context. join/leave is mechanism. Keep mechanism minimal. |
| MCP server | 568 | **Gut.** Zero production consumers. 12 tools no agent calls. |
| Network/relay | 764 | Freeze. Works, don't extend. |
| Tasks CLI | 164 | **Cut.** WritBase territory. `tasks.ts` stays (handoff reads it). |

### Resolver Health (18 registered)

| Status | Count | Resolvers |
|---|---|---|
| **Working** | 8 | `crew-status`, `crew-locks`, `git-delta`, `git-staged`, `edit-diff`, `handoff`, `import-graph`, `session-diff` |
| **Incomplete** | 4 | `file-errors`/`validate-file` (only work after async validation populates cache), `syntax-check` (JS-only, no TS), `test-failures` (slow, not in defaults) |
| **Dead** | 3 | `crew-todos` (cache never written), `claimed-errors` (cache never written), `git-context` before-edit (`last-read:` cache never written) |
| **Niche** | 3 | `custom`, `git-diff-stat`, `context-rules` (all work, expert-only) |

### Test Totals

27 suites, 439 tests, 0 failures, 0 typecheck errors, 0 lint errors.

---

## Phase 0: Stabilize

**Goal:** Every resolver in `DEFAULT_ACTIVE_RULES` produces non-empty output in the happy path. Zero dead resolvers.

### 0.1 Kill dead resolvers

| Action | File | Detail |
|---|---|---|
| Remove `crew-todos` resolver | `injection-engine.ts` | Cache key `"crew-todos"` never written by any production code. Handoff resolver already provides task context via `tasks.json`. |
| Remove `crew-todos` from defaults | `injection-types.ts` | Drop from `DEFAULT_ACTIVE_RULES`, `VALID_SOURCES`, `ContextSource` |
| Remove `crew-todos` from scope map | `block-scope.ts` | Drop from `BLOCK_SOURCES` + `BLOCK_SCOPES` |
| Remove `claimed-errors` resolver | `injection-engine.ts` | Cache key `"claimed-errors"` never written. Will be rebuilt in Phase 2 as `session-validate` (with a producer). |
| Remove `claimed-errors` from defaults | `injection-types.ts` + `block-scope.ts` | Same pattern as crew-todos |

**Verify:** typecheck + lint + 439 tests pass (minus removed resolver tests).

### 0.2 Fix syntax-check for TypeScript

| Action | Detail |
|---|---|
| Add `.ts`/`.tsx` to `SYNTAX_EXT_MAP` | Use `tsc --noEmit {file}` instead of `node --check`. Fall back to `npx tsc` if not global. |
| Use ecosystem detection | `detect.ts` already knows the ecosystem. Thread `SYNTAX_EXT_MAP` extension: `.py` → `python -m py_compile`, `.go` → `go vet`, `.rs` → `cargo check --message-format=short` |
| Cache results | Same pattern as existing JS syntax check |

**Verify:** `resolveSyntaxCheck("src/foo.ts")` returns errors for a file with type errors.

### 0.3 Fix git-context before-edit (stale-read detection)

| Action | Detail |
|---|---|
| Write `last-read` cache in before-read path | When `resolveInjections("before-read", file)` runs, write `writeCache("last-read:{session}:{file}", Date.now(), 60000)` |
| Read it in before-edit | `resolveGitContext` already checks this cache — it just needs a producer |

**Verify:** Edit a file externally, then before-edit shows stale-read warning.

### 0.4 Per-resolver timeout

| Action | Detail |
|---|---|
| Wrap each resolver in `Promise.race([resolver(ctx), timeout(2000)])` | Slow resolver gets killed, chain continues. No silent budget starvation. |
| Log timeout events | `log.warn("resolver {source} timed out after 2000ms")` |

**Verify:** A resolver that sleeps 5s doesn't block others.

### 0.5 Wire `triggerAsyncValidation` to on-idle

| Action | Detail |
|---|---|
| Add `triggerAsyncValidation()` call in the on-idle resolver cycle | Ensures `file-errors`/`validate-file` caches are populated even when hooks don't fire `--async-validate` |

**Verify:** `file-errors` returns content after an idle tick without any prior after-edit hook.

### Phase 0 Success Criteria

- [ ] 0 dead resolvers (was 3)
- [ ] `syntax-check` works for `.ts`/`.tsx` (was JS-only)
- [ ] `git-context` before-edit shows stale-read warnings (was dead)
- [ ] No resolver can starve the 5s budget (was possible)
- [ ] `file-errors`/`validate-file` populated by on-idle (was hook-dependent)
- [ ] All tests pass

---

## Phase 1: Trim

**Goal:** Remove every LOC that doesn't produce or deliver context.

### 1.1 Gut MCP server

The MCP server is 568 LOC. No agent autonomously calls MCP tools in 2026. Keep the thin read layer; remove management.

| Keep (read-only) | Remove (management) |
|---|---|
| 6 resource templates (`pmd://blocks`, `pmd://blocks/{source}`, `pmd://crew/status`, `pmd://tasks`, `pmd://tasks/{id}`, `pmd://crew/locks/{path}`) | `pmd_task_create`, `pmd_task_update` |
| `pmd_blocks_execute` (resolves blocks, is a read operation) | `pmd_task_claim_next` |
| `pmd_validate_file` (produces context via validation cache) | `pmd_crew_claim`, `pmd_crew_release` |
| | `pmd_crew_join`, `pmd_crew_leave`, `pmd_crew_note` |
| | `pmd_cache_invalidate` |

**Verify:** MCP server starts, resources work, 9 management tools gone. ~250 LOC removed.

### 1.2 Remove `pmd task` CLI

The handoff resolver reads `tasks.json` — that's context. The CRUD CLI that manages it is orchestration.

| Keep | Remove |
|---|---|
| `src/core/tasks.ts` (164 LOC) — handoff resolver reads it | `src/commands/task.ts` (146 LOC) |
| `tasks.json` file format | `pmd task` CLI registration in `src/index.ts` |
| | Task-related MCP tools (already removed in 1.1) |

Tasks can be managed by any external tool (WritBase, orchestrator, manual JSON edit). The handoff resolver reads whatever is there.

**Verify:** `pmd task` command gone. Handoff resolver still injects task context when `tasks.json` exists.

### 1.3 Strip dead exports

- Remove task-related imports from `mcp-server.ts`
- Remove unused crew imports from `mcp-server.ts`
- Clean up `package.json` if task-related deps exist

**Verify:** `npx tsc --noEmit` clean. `npx eslint src/core/mcp-server.ts` clean.

### Phase 1 Success Criteria

- [ ] ~400 LOC removed
- [ ] MCP server is read-only (6 resources + 2 tools)
- [ ] `pmd task` CLI removed
- [ ] Zero dead imports/exports
- [ ] All tests pass

---

## Phase 2: Harden

**Goal:** Every default rule produces fresh, relevant context. The injection pipeline is bulletproof for single machine with 1-5 agents.

### 2.1 Rebuild `session-validate` resolver

Replace the dead `claimed-errors` with a resolver that actually RUNS validation.

| Action | Detail |
|---|---|
| New `session-validate` resolver | Resolves active session's claimed files. Runs `eslint --no-error-on-unmatched-pattern {files}` with 4s timeout. Caches result keyed by `session-validate:{sessionId}`. |
| Register in defaults | `after-edit` (global, async, max-lines 20) + `on-idle` (global, max-lines 20) |
| Scope | `local` — tied to session's claimed files |

**Verify:** Agent claims 3 files, introduces a lint error → session-validate shows only errors from those 3 files.

### 2.2 Wire `test-failures` into on-idle

| Action | Detail |
|---|---|
| Add `test-failures` to on-idle defaults | `on-idle: { source: "test-failures", scope: "global", "max-lines": 10 }` |
| Individual timeout | 15s budget for test-failures (won't starve others with per-resolver timeout from Phase 0.4) |

**Verify:** Failing test injected on idle tick without starving other resolvers.

### 2.3 Ecosystem-aware syntax checking

| Action | Detail |
|---|---|
| Use `detect.ts` output | At daemon start, detect ecosystem and configure `SYNTAX_EXT_MAP` accordingly |
| `.ts`/`.tsx` → `tsc --noEmit` | Already done in Phase 0.2 |
| `.py` → `python -m py_compile` | Only if ecosystem is Python |
| `.go` → `go vet` | Only if ecosystem is Go |
| `.rs` → `cargo check --message-format=short 2>&1` | Only if ecosystem is Rust |

**Verify:** Syntax errors detected for each ecosystem's primary language.

### 2.4 `pmd doctor` validates resolver health

| Action | Detail |
|---|---|
| Add resolver health check to `pmd doctor` | For each source in `DEFAULT_ACTIVE_RULES`, run the resolver and check it returns non-empty (or at least doesn't throw) |
| Report dead resolvers | `"⚠️ import-graph: returned empty (no target file — ok if no hooks fired)"` |

**Verify:** `pmd doctor` reports resolver health status.

### Phase 2 Success Criteria

- [ ] `session-validate` replaces `claimed-errors` (producer + consumer)
- [ ] `test-failures` in default on-idle rules
- [ ] Syntax checking works for TS/Python/Go/Rust
- [ ] `pmd doctor` validates resolver health
- [ ] All default rules produce context in the happy path
- [ ] All tests pass

---

## Phase 3: Inter-Harness Context

**Goal:** Two different harnesses on the same machine share context seamlessly.

**Prerequisite:** Phases 0-2 complete. Zero dead resolvers. Zero broken resolvers.

### 3.1 Wire shared blocks into daemon periodic cycle

| Action | Detail |
|---|---|
| Push shared blocks every 30s | Daemon already has a relay client. Add periodic `pushBlocks()` for shared sources (test-failures, git-delta, git-staged, context-rules, handoff) |
| Fetch shared blocks every 30s | Existing `fetchBlocks()` already does this. Wire into injection pipeline so remote blocks are available to resolvers. |
| Shared block injection | When `resolveTestFailures` runs, check both local cache AND remote blocks from relay. Prefer freshest. |

**Verify:** Claude Code + OpenCode both see each other's crew status via relay blocks.

### 3.2 Cross-harness injection rules

| Action | Detail |
|---|---|
| Injection config supports remote sources | `"when on-idle, if remote sessions exist, inject their test-failures"` |
| Conditional injection | Only inject remote blocks when remote sessions are detected (avoid noise for solo dev) |

**Verify:** Agent sees test failures from a different harness's session.

### Phase 3 Success Criteria

- [ ] Two harnesses on same machine share shared blocks via relay
- [ ] No code changes needed — works with existing `pmd link` setup
- [ ] Solo dev sees zero overhead (no remote blocks when no remote sessions)
- [ ] All tests pass

---

## Phase 4: Network

**Gated on Phases 0-3 being perfect. Not started until single-machine experience is flawless.**

Multi-machine relay. Same principle — context sharing, not orchestration.

- Encrypted peer sync (TLS, not plain HTTP)
- Discovery protocol (mDNS for LAN, manual for WAN)
- Conflict resolution across machines

---

## What We're Not Doing

| Item | Status | Why |
|------|--------|-----|
| MCP management tools | **Cut** | No agent autonomously calls MCP tools in 2026. Read-only MCP is sufficient. |
| `pmd task` CLI | **Cut** | Orchestration, not context. `tasks.json` stays (handoff reads it). External tools manage it. |
| Link relay persistence | Paused | Phase 4 is gated on Phase 3 proof |
| Mesh gossip protocol | Cut | Star topology suffices |
| SSH tunnel management | Cut | Users compose with existing tools |
| Team mode / RBAC | Cut | Single-user DX must be flawless first |
| Custom DSL or sandboxing | Cut | Blocks are bash scripts. No new runtime. |
| Editor integrations (cursor position, selection) | Cut | Different product surface. PipeMD injects on tool calls, not keystrokes. |
| Agent fleet orchestration | **Cut** | CAO/Weave territory. PipeMD provides context, not task assignment or scheduling. |

## Design Principles

1. **Everything produces or delivers context.** If a feature doesn't feed the injection engine or deliver its output to an agent, it doesn't belong in PipeMD.
2. **Resolver-first.** Build resolvers (work via hooks immediately). Expose via MCP later (when ecosystem catches up).
3. **No new config files.** Everything stays in `injection.yml` and CLI flags.
4. **Read orchestration state, don't manage it.** PipeMD reads crew sessions, tasks, and git state to produce context. It doesn't assign tasks, schedule agents, or manage fleets.
5. **Every resolver must have a producer.** A resolver that reads from a cache key that nothing writes is dead code. Kill it or build the producer.

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Agent vendors ship native injection | Medium | PipeMD's moat is cross-agent universality + named-pipe PUSH speed. Vendor solutions fragment across ecosystems. |
| Solo agents dominate, crew has zero pull | Medium-High | Phases 0-2 serve solo agents perfectly. Crew is additive, not required. |
| Named pipes break on new platforms | Low | Legacy mode (file watcher) is first-class fallback. |
| MCP adoption remains low | High | MCP server is already trimmed to read-only. Minimal investment. The hook/plugin path is the working delivery mechanism. |
