# PipeMD Roadmap

*Last updated: 2026-06-11*

> **PipeMD is a context provider. Its job: resolve fresh, relevant context and push it to AI agents faster than anything else.**

## The Product

The injection engine IS the product. Named-pipe PUSH (sub-ms, kernel-level). Hook-based active injection on every tool call. Bidirectional write-back. Everything else exists to feed or deliver that engine.

The moat: cross-harness, sub-ms context delivery via named pipes. No other tool does this.

## Scorecard

| Phase | Exit Criterion | Status |
|-------|---------------|--------|
| **0. Stabilize** | Zero dead resolvers. Per-resolver timeouts. | **Done** (`8719fab`) |
| **1. Trim** | MCP server gone. Task CLI gone. ~836 LOC removed. | **Done** (`8719fab`) |
| **2. Harden** | 41 block types across 7 ecosystems. Compact quality summaries. Token budgets enforced. | **In Progress** |
| **2B. Measure** | Token cost, latency, and accuracy contracts per resolver. CI ratchet. Agent A/B bench. | **In Progress** (Layer 3 first) |
| **3. Inter-Harness** | Two harnesses, same machine, shared context via relay. | Planned |
| **4. Network** | Multi-machine relay. Gated on Phases 2-3. | Paused |

---

## Completed Work

### Phase 0 + 1: Stabilize & Trim — `8719fab` (2026-06-08)

One commit that cut scope rather than adding it. Removed:

- MCP server (568 LOC) — zero production consumers, no agent calls any of the 12 tools
- `pmd task` CLI (146 LOC) — orchestration, not context
- Dead resolvers: `crew-todos` (cache never written), `claimed-errors` (cache never written), `git-context` before-edit (`last-read:` cache never written)
- Net: ~836 LOC removed, one dependency dropped

Kept: `tasks.ts` (handoff resolver reads `tasks.json`), relay (works, don't extend), crew mechanism.

### Phase 2 Progress (2026-06-08 to 2026-06-11)

| Shipped | Commit | Detail |
|---------|--------|--------|
| Script-based resolver system | `15e7835` | Bash scripts per ecosystem, SCRIPT_LIBRARY registry, 7 ecosystems detected |
| Exports block | `15e7835` | Per-module exported symbols + env var references |
| Import-graph rewrite | `c36f588` | Module dependency graph with imported symbol names |
| Per-command timeouts | `c36f588` | Individual timeout budgets per resolver command |
| Test-summary caching | `c36f588` | Avoid re-running test suites on every injection |
| Compact lint summaries | `caa1fa5` | Rule frequency, severity split, `PMD_LINT_SEVERITY` env var |
| Workspace-map block | `4caf297` | Monorepo member detection (pnpm/npm/yarn/cargo/go) |
| Angular-structure block | `4caf297` | Standalone vs NgModule, routes, inventory, key dirs |
| Django-urls block | `4caf297` | URL patterns from `urls.py` files |
| Detection fixes | `4caf297` | manage.py → Python, angular.json → Angular, Cargo workspace + go.work → workspace-map |
| Dead import cleanup | `0ee95e1` | 30 unused imports removed, duplicate import fixed, eslint env for plugin |
| Hotspots block | `b2cb434` | Git churn frequency for bug-prone file identification |
| Now block | `7eb6485` | Timestamp with configurable interval rounding, crew solo suppression |
| ast-grep integration | `4819d19` | Structural code parsing for express-routes, fastapi-routes, react-components. Regex fallback when binary unavailable. |
| ESM binary resolution fix | `7b865dc` | `createRequire(import.meta.url)` for resolving `@ast-grep/cli` binary in ESM daemon |
| Env-parity test harness | `dbf3e67` + `611430b` | Plain-node test suite under `test:parity`: verifies binary resolution, env propagation, dead-code contracts. Both tsx and plain-node guards catch the createRequire bug. |
| Dead-code block with knip | `5de3fee` + `33ca017` | Self-caching stale-while-revalidate, knip runner, JSON formatter. Dogfooded on day one: removed 42 unused exports, 15 unused types, and the zod dependency. |
| Dead exports cleanup | `67f798b` | 42 symbols unexported, 4 dead constants removed, zod dropped from dependencies |
| Now source + express-routes scoping | `b36865f` | `now` source in injection.yml, search paths scoped to src/routes/app/lib |
| Project lexicon | `5341394` | Complete glossary of ~165 domain terms in `docs/lexicon.md` |

---

## Current State

### Codebase — 10,693 LOC (src/) + ~5,200 LOC (scripts/)

| Concern | LOC | Verdict |
|---|---|---|
| Injection pipeline | 2,458 | **The product.** |
| Hook adapters (Claude/Gemini/OpenCode) + plugins | 2,082 | **Delivery mechanism.** |
| Commands + init system | 2,836 + 1,390 | CLI surface. |
| Detection (ecosystem/harness) | 651 | Keep. |
| Tracing / dashboard | 662 | Debug tooling. Shrink when Phase 2B ships real numbers. |
| Network/relay | 763 | Freeze. |
| Daemon lifecycle | 527 | Keep. |
| Statusline | 332 | Keep. |
| Crew sessions | 308 | Minimal mechanism. |
| Utilities | 321 | Keep. |
| Bash scripts | ~5,200 | **The content.** 96 resolver scripts (per-ecosystem + shared), 10 library scripts. |

### 41 Block Types

| Category | Blocks |
|----------|--------|
| **Architecture** | `arch` |
| **Project** | `tree`, `deps`, `todos`, `exports`, `workspace-map` |
| **Quality** | `lint`, `type-check`, `test-summary`, `dead-code` |
| **Git** | `git-log`, `git-branch`, `git-status`, `diff-stat`, `hotspots` |
| **API** | `express-routes`, `nest-controllers`, `fastapi-routes`, `django-urls` |
| **Frontend** | `nextjs-app-router`, `react-components`, `angular-routes`, `angular-structure` |
| **Database** | `prisma-schema` (via compose), `django-models`, `sqlalchemy` |
| **Systems** | `cargo-deps`, `cargo-features`, `go-packages`, `go-interfaces`, `cmake-targets`, `class-diagram`, `interfaces`, `include-graph` |
| **DevOps** | `docker-stats`, `compose`, `k8s-unhealthy`, `tf-state`, `aws-context` |
| **Context** | `now` |
| **Crew** | `crew` |

### Test & Quality

| Gate | Result |
|------|--------|
| `pnpm build` | Clean (321 KB) |
| `tsc --noEmit` | 0 errors |
| `eslint .` | 0 errors, 17 warnings (all `no-explicit-any` or internal-only vars) |
| `test:parity` | 16/16 pass (3 env-parity + 13 dead-code, plain node) |
| `test:unit` | 23 suites, ~350+ tests, 0 failures |
| `test:e2e` | 81 scripts pass |
| Fixtures | 15 (6 ecosystems + DevOps + monorepo) |
| Test files | 27 |

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

**Goal:** Every resolver has a measurable token cost, latency, and accuracy contract. Regressions caught by CI, not by agents. Agent-level value validated by A/B bench.

### Core insight

PipeMD's claim: the block is cheaper and fresher than the shell command it replaces. Three measurable axes:

- **Efficiency** = information delivered / tokens spent
- **Accuracy** = does the block match ground truth right now?
- **Exploration reduction** = tool calls an agent didn't have to make

### Layering decision

Layer 2 (intrinsic, CI, deterministic) and Layer 3 (agent A/B, manual, expensive) are complementary, not substitutable:

- **Layer 2** is regression discipline — catches 40% token bloat on every commit, cheaply, in CI. Still planned.
- **Layer 3** answers the value question — do the 41 blocks actually help agents? Only an agent A/B can answer this.

Layer 3 is being done first because it's the most important unanswered question: at 41 blocks and growing, "do these earn their tokens in real agent behavior?" must be answered before investing in CI ratchets. If Layer 3 reveals blocks don't help, Layer 2's targets change.

### 2B.1 Intrinsic benchmark harness (Layer 2 — planned)

| Action | Detail |
|---|---|
| Create intrinsic bench | One test file per ecosystem, running each ecosystem's resolvers against its fixture |
| Token snapshot | For each fixture x resolver: run script, estimate tokens via `estimateTokens()`, record in `BENCHMARKS.md` |
| Latency snapshot | Wall-clock time per resolver. Fail if exceeds `commandTimeouts` budget |
| Accuracy golden | For structural resolvers (arch, exports, workspace-map): compare output against committed golden file |
| CI gate | `pnpm bench` runs on every PR. Fail if any resolver: empty output, exceeds token budget, exceeds timeout, golden mismatch |

### 2B.2 Resolver contract tests (Layer 2 — planned)

| Action | Detail |
|---|---|
| Every fixture x every applicable resolver | Non-empty output, under token limit, under timeout |
| Grow fixture corpus | 5-8 fixtures per ecosystem (vendor trimmed copies of real OSS repos) |
| Refresh integration test | Copy fixture → `pmd refresh` → assert all configured blocks produce non-empty output |

### 2B.3 Token ratchet (Layer 2 — planned)

| Action | Detail |
|---|---|
| Snapshot current token counts per block | Committed baseline in `BENCHMARKS.md` |
| Fail CI if any block grows >15% | Prevents silent token bloat |
| Fail CI if any block shrinks >50% | Catches silent failures (empty output that passes "non-empty" by having a header) |

### 2B.4 Agent A/B Benchmark (Layer 3 — in progress)

**Goal:** Measure whether PipeMD context reduces exploration cost on real development tasks.

**Methodology:**

| Parameter | Value |
|-----------|-------|
| Agent | GLM-5.1 via OpenCode CLI (`opencode run`) |
| Runs per cell | N=5, report median + min/max |
| WITH PipeMD | Full active mode: daemon running, context file rendered, hooks injecting per tool call |
| WITHOUT PipeMD | Pristine git clone, never touched by PipeMD |
| Isolation | Fresh `git worktree` per run |
| Quality gate | Automated per-scenario (build/lint/test). Report quality alongside efficiency. Only compare at equal quality. |
| Temperature | 0 (reduce variance) |

**Three scenarios (designed for low block alignment):**

| # | Target | Task | Block alignment |
|---|--------|------|-----------------|
| 1 | pipemd | Add `pmd crew export` subcommand | Low — no single block answers this |
| 2 | hono | Add request logging middleware | Low — requires understanding middleware wiring |
| 3 | hono | Refactor error handling to centralized handler | Low — requires understanding full API layer |

**Metrics (reported separately, never combined):**

- Input tokens (context overhead — PipeMD should increase this)
- Output tokens (agent reasoning — PipeMD should decrease this)
- Tool calls by type: read, glob, grep, edit, write
- Wall time (seconds)
- Quality score: 0 (broken) / 1 (partial) / 2 (complete, passes checks)

**Design principles for trustworthiness:**

1. **The bench can tell us PipeMD loses.** If 41 blocks add token tax without reducing exploration, that's the finding.
2. **Quality gates prevent "fast but wrong" from winning.** Only compare efficiency at equal quality levels.
3. **Block alignment is audited.** Scenarios are general development tasks where context helps incidentally.
4. **Variance is reported.** If WITH/WITHOUT distributions overlap, there's no effect regardless of medians.
5. **Repos are pinned to tags.** Reproducible baselines.

### Phase 2B Success Criteria

- [ ] Agent A/B bench runs 3 scenarios × 2 conditions × 5 repetitions
- [ ] Every scenario has an automated quality gate
- [ ] Results report all six metric axes separately with variance
- [ ] Finding is reported neutrally — whether PipeMD wins or loses on efficiency
- [ ] `pnpm bench` intrinsic harness runs in <30s (Layer 2 — still planned)
- [ ] Token ratchet catches >15% growth (Layer 2 — still planned)

---

## Phase 3: Inter-Harness Context

**Goal:** Two different harnesses on the same machine share context seamlessly.

**Prerequisite:** Phases 2-2B complete. Measurable quality.

### 3.1 Wire shared blocks into daemon periodic cycle

| Action | Detail |
|---|---|
| Push shared blocks every 30s | Daemon already has a relay client. Add periodic block push for shared sources |
| Fetch shared blocks every 30s | Existing fetch mechanism already does this. Wire into injection pipeline |
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

**Gated on Phases 2-3. Not started until single-machine experience is flawless.**

Multi-machine relay. Context sharing, not orchestration.

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
| Token bloat from rich blocks | Medium | Token ratchet (Phase 2B) catches growth before it compounds. Agent bench validates that blocks earn their tokens. |
