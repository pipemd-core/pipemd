# PipeMD Roadmap

*Last updated: 2026-06-09*

> **PipeMD is a context provider. Its job: resolve fresh, relevant context and push it to AI agents faster than anything else.**

## The Product

The injection engine IS the product. Named-pipe PUSH (sub-ms, kernel-level). Hook-based active injection on every tool call. Bidirectional write-back. Everything else exists to feed or deliver that engine.

The moat: cross-harness, sub-ms context delivery via named pipes. No other tool does this.

## Scorecard

| Phase | Exit Criterion | Status |
|-------|---------------|--------|
| **0. Stabilize** | Zero dead resolvers. Zero broken resolvers. Every default rule produces non-empty output in the happy path. | **Done** (8719fab) |
| **1. Trim** | Remove every LOC that doesn't produce or deliver context. MCP server gone. Task CLI gone. Dead resolvers gone. | **Done** (8719fab) |
| **2. Harden** | Rich ecosystem-specific blocks. Compact quality summaries. Per-command timeouts. Token budgets enforced. | **In Progress** |
| **2B. Measure** | Every resolver has a measurable token cost, latency, and accuracy contract. Regressions caught by CI. | Planned |
| **3. Inter-Harness** | Two different harnesses on the same machine share context seamlessly via relay. | Planned |
| **4. Network** | Multi-machine relay. Context sharing, not orchestration. Gated on Phases 2-3 being perfect. | Paused |

---

## Completed Phases

### Phase 0: Stabilize — Done

Dead resolvers removed (`crew-todos`, `claimed-errors`, `git-context` before-edit). Per-resolver timeouts implemented. `triggerAsyncValidation` wired to on-idle.

### Phase 1: Trim — Done

- MCP server removed entirely (was 568 LOC, zero production consumers)
- `pmd task` CLI removed (was 146 LOC, orchestration not context)
- Dead resolvers killed (~836 LOC removed total)
- `tasks.ts` kept — handoff resolver reads `tasks.json`

### Phase 2 Progress (June 8-9)

| Shipped | Commit | Detail |
|---------|--------|--------|
| Ecosystem-specific script blocks | 15e7835 | 20+ resolvers via bash scripts, ecosystem detection, SCRIPT_LIBRARY |
| Exports block + env vars | 15e7835 | Per-module exported symbols + env var references |
| Import-graph with symbol names | c36f588 | Module dependency graph with imported symbol names |
| Per-command timeouts | c36f588 | Individual timeout budgets per resolver command |
| Test-summary caching | c36f588 | Avoid re-running test suites on every injection |
| Compact lint summaries | caa1fa5 | Rule frequency, severity split, `PMD_LINT_SEVERITY` env var |
| Workspace-map block | 4caf297 | Monorepo member detection (pnpm/npm/yarn/cargo/go) |
| Angular-structure block | 4caf297 | Standalone vs NgModule, routes, inventory, key dirs |
| Django-urls block | 4caf297 | URL patterns from `urls.py` files |
| Detection fixes | 4caf297 | manage.py, angular.json, Cargo workspace, go.work |
| Dead import cleanup | — | 35 unused imports removed across 18 files |

---

## Current State: Honest Inventory

### Codebase (~9,800 LOC)

| Concern | LOC | Verdict |
|---|---|---|
| Block rendering / injection pipeline | 2,090 | **The product.** |
| Hook adapters (Claude/Gemini/OpenCode) | 686 | **Delivery mechanism.** |
| Daemon lifecycle | 367 | Keep. |
| Detection (ecosystem/harness) | 632 | Keep. |
| Tracing / dashboard | 662 | Debug tooling. Shrink. |
| Statusline | 153 | Keep. |
| Utilities | 142 | Keep. |
| Crew sessions | 706 | Keep mechanism minimal. |
| Network/relay | 764 | Freeze. Works, don't extend. |
| Bash scripts (resolvers) | ~1,200 | **The content.** Growing per ecosystem. |

### Script-Based Resolvers (30+)

| Category | Blocks |
|----------|--------|
| **Architecture** | `arch`, `deps`, `tree` |
| **Project** | `todos`, `exports`, `workspace-map` |
| **Quality** | `lint`, `type-check`, `test-summary` |
| **Git** | `git-log`, `git-branch`, `git-status`, `diff-stat` |
| **API** | `express-routes`, `nest-controllers`, `fastapi-routes`, `django-urls` |
| **Frontend** | `nextjs-app-router`, `react-components`, `angular-routes`, `angular-structure` |
| **Backend** | `prisma-schema`, `django-models`, `sqlalchemy-models` |
| **Systems** | `cargo-deps`, `cargo-features`, `go-packages`, `go-interfaces` |
| **DevOps** | `docker-stats`, `compose`, `cmake-targets` |
| **Crew** | `crew` |

### Test Totals

33 tests, 0 failures, 0 typecheck errors, 7 lint warnings (all `no-explicit-any`), build clean.

### Quality Gate Status

| Gate | Status |
|------|--------|
| `pnpm build` | Clean |
| `tsc --noEmit` | 0 errors |
| `eslint src/` | 7 warnings (all `no-explicit-any`) |
| Test suite | 33/33 pass |

---

## Phase 2: Harden (Remaining)

**Goal:** Every default rule produces fresh, relevant context. The injection pipeline is bulletproof for single machine.

### 2.1 Rebuild `session-validate` resolver

Replace the dead `claimed-errors` with a resolver that actually RUNS validation.

| Action | Detail |
|---|---|
| New `session-validate` resolver | Resolves active session's claimed files. Runs `eslint --no-error-on-unmatched-pattern {files}` with 4s timeout. |
| Register in defaults | `after-edit` (global, async, max-lines 20) + `on-idle` (global, max-lines 20) |
| Scope | `local` — tied to session's claimed files |

### 2.2 Ecosystem-aware syntax checking

| Action | Detail |
|---|---|
| `.ts`/`.tsx` → `tsc --noEmit` | Use ecosystem detection from `detect.ts` |
| `.py` → `python -m py_compile` | Only if ecosystem is Python |
| `.go` → `go vet` | Only if ecosystem is Go |
| `.rs` → `cargo check` | Only if ecosystem is Rust |

### 2.3 `pmd doctor` validates resolver health

| Action | Detail |
|---|---|
| Run each resolver | For each source in `DEFAULT_ACTIVE_RULES`, run and check non-empty or doesn't throw |
| Report dead resolvers | `"⚠️ import-graph: returned empty"` |

### Phase 2 Success Criteria

- [ ] `session-validate` replaces `claimed-errors` (producer + consumer)
- [ ] Syntax checking works for TS/Python/Go/Rust
- [ ] `pmd doctor` validates resolver health
- [ ] All default rules produce context in the happy path

---

## Phase 2B: Measure

**Goal:** Every resolver has a measurable token cost, latency, and accuracy contract. Regressions caught by CI, not by agents.

### Core insight

PipeMD's claim: the block is cheaper and fresher than the shell command it replaces. Two measurable axes:

- **Efficiency** = information delivered / tokens spent
- **Accuracy** = does the block match ground truth right now?

### 2B.1 Intrinsic benchmark harness

| Action | Detail |
|---|---|
| Create `bench/` directory | One test file per ecosystem, running each ecosystem's resolvers against its fixture |
| Token snapshot | For each fixture x resolver: run script, estimate tokens via `estimateTokens()`, record in `BENCHMARKS.md` |
| Latency snapshot | Wall-clock time per resolver. Fail if exceeds `commandTimeouts` budget |
| Accuracy golden | For structural resolvers (arch, exports, workspace-map): compare output against committed golden file |
| CI gate | `pnpm bench` runs on every PR. Fail if any resolver: empty output, exceeds token budget, exceeds timeout, golden mismatch |

### 2B.2 Resolver contract tests

| Action | Detail |
|---|---|
| Every fixture x every applicable resolver | Non-empty output, under token limit, under timeout |
| Grow fixture corpus | 5-8 fixtures per ecosystem (vendor trimmed copies of real OSS repos) |
| Refresh integration test | Copy fixture -> `pmd refresh` -> assert all configured blocks produce non-empty output |

### 2B.3 Token ratchet

| Action | Detail |
|---|---|
| Snapshot current token counts per block | Committed baseline in `BENCHMARKS.md` |
| Fail CI if any block grows >15% | Prevents silent token bloat |
| Fail CI if any block shrinks >50% | Catches silent failures (empty output that passes "non-empty" by having a header) |

### Phase 2B Success Criteria

- [ ] `pnpm bench` runs in <30s across all fixtures
- [ ] Every default resolver has a committed token + latency baseline
- [ ] Golden files exist for structural resolvers (arch, exports, workspace-map)
- [ ] Token ratchet catches >15% growth
- [ ] Refresh integration test covers at least 3 ecosystems

---

## Phase 3: Inter-Harness Context

**Goal:** Two different harnesses on the same machine share context seamlessly.

**Prerequisite:** Phases 2-2B complete. Zero dead resolvers. Measurable quality.

### 3.1 Wire shared blocks into daemon periodic cycle

| Action | Detail |
|---|---|
| Push shared blocks every 30s | Daemon already has a relay client. Add periodic `pushBlocks()` for shared sources |
| Fetch shared blocks every 30s | Existing `fetchBlocks()` already does this. Wire into injection pipeline |
| Shared block injection | Check both local cache AND remote blocks. Prefer freshest. |

### 3.2 Cross-harness injection rules

| Action | Detail |
|---|---|
| Injection config supports remote sources | `"when on-idle, if remote sessions exist, inject their test-failures"` |
| Conditional injection | Only inject remote blocks when remote sessions detected (avoid noise for solo dev) |

### Phase 3 Success Criteria

- [ ] Two harnesses on same machine share shared blocks via relay
- [ ] No code changes needed — works with existing `pmd link` setup
- [ ] Solo dev sees zero overhead (no remote blocks when no remote sessions)

---

## Phase 4: Network

**Gated on Phases 2-3 being perfect. Not started until single-machine experience is flawless.**

Multi-machine relay. Same principle — context sharing, not orchestration.

- Encrypted peer sync (TLS, not plain HTTP)
- Discovery protocol (mDNS for LAN, manual for WAN)
- Conflict resolution across machines

---

## What We're Not Doing

| Item | Status | Why |
|------|--------|-----|
| MCP server | **Cut** | Zero production consumers. Hook/plugin path is the working delivery mechanism. |
| `pmd task` CLI | **Cut** | Orchestration, not context. `tasks.json` stays (handoff reads it). |
| Link relay persistence | Paused | Phase 4 is gated on Phase 3 proof |
| Mesh gossip protocol | Cut | Star topology suffices |
| SSH tunnel management | Cut | Users compose with existing tools |
| Team mode / RBAC | Cut | Single-user DX must be flawless first |
| Custom DSL or sandboxing | Cut | Blocks are bash scripts. No new runtime. |
| Editor integrations | Cut | Different product surface. PipeMD injects on tool calls, not keystrokes. |
| Agent fleet orchestration | **Cut** | CAO/Weave territory. PipeMD provides context, not task assignment. |

## Design Principles

1. **Everything produces or delivers context.** If a feature doesn't feed the injection engine or deliver its output to an agent, it doesn't belong in PipeMD.
2. **Resolver-first.** Build resolvers (work via hooks immediately). Expose via other surfaces later.
3. **No new config files.** Everything stays in `injection.yml` and CLI flags.
4. **Read orchestration state, don't manage it.** PipeMD reads crew sessions, tasks, and git state to produce context. It doesn't assign tasks, schedule agents, or manage fleets.
5. **Every resolver must have a producer.** A resolver that reads from a cache key that nothing writes is dead code. Kill it or build the producer.
6. **Measure, don't guess.** Every block has a token cost, a latency budget, and an accuracy contract. Regressions are caught by machines, not by agents.

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Agent vendors ship native injection | Medium | PipeMD's moat is cross-agent universality + named-pipe PUSH speed. |
| Solo agents dominate, crew has zero pull | Medium-High | Phases 2-2B serve solo agents perfectly. Crew is additive. |
| Named pipes break on new platforms | Low | Legacy mode (file watcher) is first-class fallback. |
| Token bloat from rich blocks | Medium | Token ratchet (Phase 2B) catches growth before it compounds. |
