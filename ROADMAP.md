# PipeMD Roadmap

*Last updated: 2026-07-05*

> **PipeMD is a context provider. Its job: resolve fresh, relevant context and
> push it to AI agents faster than anything else.**

## The Product

The injection engine IS the product. Named-pipe PUSH (sub-ms, kernel-level).
Hook-based active injection on every tool call. Bidirectional write-back.
Everything else exists to feed or deliver that engine.

The moat: cross-harness, sub-ms context delivery via named pipes. No other tool
does this.

---

## The ML Verdicts — What 15 Versions of Research Concluded

A 15-version research effort (`ml` branch, V1–V15) investigated ML-driven
context injection. The arc is documented in `docs/ml-lessons-for-main.md` and
the per-version CDCs/postmortems. Three product verdicts survived:

| Verdict | Evidence | Confidence |
|---|---|---|
| **Injection helps on average** (~−29 s/step; IPTW 95% CI excludes 0) | V10 causal measurement, low confounding (propensity AUC 0.514) | n=5 sessions — promising, not final |
| **"Always inject within budget" is the best-supported policy** | V10 observational-best; **V15 prospective A/B confirms it causally** (adaptive boost loses at equal quality) | Highest we have — prospective, one task |
| **ML-based per-context selection has not earned its place** | V1–V14 observational negatives; V15 prospective negative for the boost shape | Strong for the boost shape; the suppress shape is untested |
| **The topology filter is a free, deterministic token win** | V15 prospective: −30% input tokens at equal quality, zero ML | Confirmed on one task (TS-only); the one shippable ML-derived artifact |

**The deep lesson (V15 §4c):** *observational learnability ≠ causal policy
value*. V14's most-durable signal (rewrite-rate, +0.0123) became a policy (V15
boost) that lost causally. Any future ML-informed policy must be tested
prospectively before its "direction" can be trusted.

**The strategic lesson (V10/V15):** value lives in the **content layer**
(resolvers, freshness, signal density), not the **selection layer** (ML picking
which block). The smartest selection never beat always-inject; the file's own
content (`file-content`, `file-errors`) carried the strongest measured reward.
The roadmap below redirects effort accordingly.

---

## Scorecard

| Phase | Exit Criterion | Status |
|-------|---------------|--------|
| **0. Stabilize** | Zero dead resolvers. Per-resolver timeouts. | **Done** (`8719fab`) |
| **1. Trim** | MCP server gone. Task CLI gone. ~836 LOC removed. | **Done** (`8719fab`) |
| **2. Harden** | 41 block types across 7 ecosystems. Compact quality summaries. Token budgets enforced. | **In Progress** |
| **2A. ML-Derived Defaults** | Topology filter in the active baseline. Rewrite-tracker as dormant infra. | **Ready to ship** (V15 main-lane-clean) |
| **2B. Measure** | Token cost, latency, and accuracy contracts per resolver (Layer 2). Prospective A/B harness (Layer 3). | **In Progress** (Layer 3 harness built by V15) |
| **2C. Content Layer** | Resolver quality, freshness, and signal density for the high-reward blocks. | **Planned** (the positive V10/V15 agenda) |
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

### ML Research — V1–V15 (closed on `ml` branch)

| Version | What it was | Outcome |
|---|---|---|
| V1–V4 | Proxy-prediction (next action, behavioral labels) | Failed — proxies don't measure success |
| V5/V5b | Forward-looking error onset | **Contamination artifact** (AUC 0.92 was bench leak) |
| V6 | Dynamics features for V5 label | Wrong target/streams/degenerate |
| V7 | Step-level error onset + **topology** | Topology is the durable signal (15× label spread); type/test near-random |
| V8 | + code content | **Label-leakage false positive** (0.596 → 0.506 on corrected label) |
| V9 | File-scoped error onset (label fix) | **Honestly random** — proxies exhausted |
| V10 | **First causal reward measurement** (IPTW) | Average −29 s; per-context not learnable (R²=−1.09); "always inject" is observational-best |
| V11 | Content-fit reward via simulation (~1 M labels) | D1_graded target learns (Ridge 0.13, LGB 0.16) — the content-fit ceiling begins |
| V12 | Feature re-test on V11 target | Topology REHABILITATED (+0.0052 Ridge); all V6 dynamics re-reverted |
| V13 | Maximize content-fit R² via 5 levers | LGB R²=0.2086; recent-action adds a small signal. The content-fit ceiling. |
| V14 | Efficiency-proxy reward (decomposed friction) | **Honest negative**: composite efficiency not learnable; rewrite features add +0.0123; **zero common support** — per-block reward structurally unobservable. Bench is mandatory. |
| V15 | **First prospective A/B of an ML-informed policy** | Adaptive boost LOSES to always-inject at equal quality. Topology filter saves 30% tokens (free win). Dedup is behavior-shaping. |

Full evidence: `docs/ml-lessons-for-main.md`, `ml/reports/v15_postmortem.md`,
`ml/reports/v10_postmortem.md`, and `docs/ml-v{7..15}-cdc.md`.

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

## Phase 2A: ML-Derived Defaults — Ship the V15 Wins

**Goal:** Promote the two main-lane-clean artifacts from the ML research that
deliver measured value with zero ML in the loop.

> **Discipline note:** the `ml` branch carries ML-only commits (the adaptive
> boost, learned-policy skeleton, the bench harness). Only the two artifacts
> below cross to `main`. The promotion is a **single clean commit**, not a
> cherry-pick of the V15 commits (which carry the boost logic that V15
> disproved). See `docs/promote-topology-filter.md` for the exact spec.

### 2A.1 Topology filter in the active-mode baseline

V7's 15× label-spread signal (`.mjs` 0.67 vs `.json` 0.045 error rate) as a
**hard file-type gate**, applied in `delivery: "active"` (the default), not
just `adaptive`.

| Action | Detail |
|---|---|
| Add `src/core/topology-filter.ts` | The deterministic per-block file-type gate (104 LOC, 100 unit tests). Already written on `ml`. |
| Wire into `resolveInjections` | Drop the `delivery === "adaptive"` guard on the topology check (`injection-engine.ts` rule filter) so it applies in **active + adaptive**. Passive/expert/learned unchanged. |
| Effect | Skip `syntax-check` for non-typeable files (`.css/.html/.md`), `file-errors` for non-lintable, `import-graph`/`exports` for non-JS/TS. Saves resolver runs + tokens. The V15 measured 30% input-token reduction is a lower bound (scenario 05 was TS-only). |

### 2A.2 Rewrite-tracker as dormant infrastructure

| Action | Detail |
|---|---|
| Add `src/core/rewrite-tracker.ts` | Session-scoped per-file edit counter (110 LOC, 19 unit tests, R-22 verified — no cross-session leak). Already written on `ml`. |
| Do NOT wire consumers on main | The only consumer today is the V15 boost, which V15 disproved. The tracker exists for the suppress-shape experiment (experimental lane) and future rewrite-aware policies. |
| Do NOT add `"adaptive"` to default delivery | `pmd init` continues to write `delivery: "active"`. Adaptive stays a non-default opt-in. |

### Phase 2A Success Criteria

- [ ] `topology-filter.ts` + `rewrite-tracker.ts` on `main` with their unit tests
- [ ] Topology filter fires under `delivery: "active"` (verified by a new test)
- [ ] No behavior change for existing users except fewer tokens on non-JS/non-lintable edits
- [ ] `tsc --noEmit`, `eslint src/`, `test:unit`, FIFO e2e (must FAIL on regression, not SKIP) all green
- [ ] Single clean commit on `main`; `experimental`/`ml` rebases to pick it up

---

## Phase 2: Harden (Remaining)

**Goal:** Every default rule produces fresh, relevant context. The injection
pipeline is bulletproof for single machine.

> **Priority reorder (V10 per-block rewards):** the resolver-investment budget
> flows to the highest-measured-reward blocks first.
>
> | Block | V10 IPTW Δ [95% CI] | Priority |
> |---|---|---|
> | `file-content` | **−58.8 s** [−78.6, −38.8] | **Invest first** — freshness, mtime-aware re-resolution |
> | `file-errors` | **−29.3 s** [−55.2, −7.1] | **Invest** — `session-validate` (§2.1) is the top of this queue |
> | `import-graph` | −23.6 s [−45.0, −0.0] | Keep; extend to dependents-at-risk (§2C.3) |
> | `crew-todos` | −18.4 s [not sig] | Demote — conditional, not default-on |
> | `git-context` | −12.4 s [not sig] | Demote — conditional, not default-on |

### 2.1 Rebuild `session-validate` resolver (feeds `file-errors` — the #2 reward block)

Replace the dead `claimed-errors` with a resolver that actually RUNS validation.

| Action | Detail |
|---|---|
| New `session-validate` resolver | Resolves active session's claimed files. Runs `eslint --no-error-on-unmatched-pattern {files}` with 4s timeout. |
| Register in defaults | `after-edit` (global, async, max-lines 20) + `on-idle` (global, max-lines 20) |
| Scope | `local` — tied to session's claimed files |

### 2.2 Ecosystem-aware syntax checking (feeds `syntax-check`)

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

### 2.4 Reconsider weak blocks (V10: not significant)

| Action | Detail |
|---|---|
| `git-context` | Move from `before-edit` default to conditional (only when the file has uncommitted changes touching it). V10 Δ = −12.4 s [−33.6, +6.4], not significant. |
| `crew-todos` | Demote from default-on. The cache producer was already removed in Phase 0; confirm no default rule references it. V10 Δ = −18.4 s [−67.4, +39.9], not significant. |

### Phase 2 Success Criteria

- [ ] `session-validate` replaces `claimed-errors` (producer + consumer)
- [ ] Syntax checking works for TS/Python/Go/Rust
- [ ] `pmd doctor` validates resolver health
- [ ] All default rules produce context in the happy path
- [ ] Weak blocks (`git-context`, `crew-todos`) are conditional, not default-on

---

## Phase 2B: Measure

**Goal:** Every resolver has a measurable token cost, latency, and accuracy
contract. Regressions caught by CI, not by agents. Agent-level value validated
by prospective A/B.

### Core insight (hardened by V10–V15)

PipeMD's claim: the block is cheaper and fresher than the shell command it
replaces. Three measurable axes:

- **Efficiency** = information delivered / tokens spent
- **Accuracy** = does the block match ground truth right now?
- **Exploration reduction** = tool calls an agent didn't have to make

**The ML research added a fourth, decisive axis:** *causal effect on agent
outcome* — measurable only by prospective A/B (V15). And it added the
methodological discipline: observational metrics are hypotheses, not evidence;
**the bench is the only unbiased arbiter** (V10 R-1, V15 R-21).

### Layering

- **Layer 2** (intrinsic, CI, deterministic) — regression discipline. Catches 40% token bloat on every commit, cheaply, in CI. Still planned.
- **Layer 3** (agent A/B, manual, expensive) — answers the value question. **The harness was built and validated by V15.** Only an agent A/B can answer "do the 41 blocks actually help agents?"

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

### 2B.4 Agent A/B Benchmark (Layer 3 — harness built by V15)

**Goal:** Measure whether PipeMD context reduces exploration cost on real
development tasks. **The harness exists** (`bench/bench-agent.sh`, extended by
V15 with the rework metric + `adaptive` condition + `--conditions`/
`--scenarios` flags). It ran the first prospective A/B (V15: 9 cells, 0 voids).

**Methodology (V15-hardened):**

| Parameter | Value |
|-----------|-------|
| Agent | GLM-5.1+ via OpenCode CLI (`opencode run`) |
| Runs per cell | N≥3 for signal-finding; N≥5 for powered claims. Report median + min/max + per-run. |
| Conditions | `with` (full active mode), `without` (pristine clone), `static` (hand-written AGENTS.md), `adaptive`/`suppress` (policy arms). |
| Isolation | Fresh `git worktree` per run |
| Quality gate | Automated per-scenario (build/lint/test). Report quality alongside efficiency. **Only compare at equal quality** (V15 R-19). |
| Timeout | `OPENCODE_TIMEOUT=1200s` for exploration-heavy scenarios (V15 R-13: 600s too short). |
| Temperature | 0 (reduce variance) |

**Scenarios (5, pinned to tags):**

| # | Target | Task | Shape |
|---|--------|------|-------|
| 1 | pipemd | Add `pmd crew export` subcommand | Fix-heavy |
| 2 | hono | Add request logging middleware | Wiring |
| 3 | hono | Refactor error handling to centralized handler | Multi-file |
| 4 | (tbd) | (tbd) | (tbd) |
| 5 | hono | `c.json()` rejects `Date` (hono #1800/#1806) | Exploration-heavy — **V15 baseline** |

**Metrics (reported separately, never combined):**

- Input tokens (context overhead — PipeMD should increase this)
- Output tokens (agent reasoning — PipeMD should decrease this)
- Tool calls by type: read, glob, grep, edit, write
- **Rework** — per-file re-edits within a run (V14's durable learnable channel; V15's primary outcome). Computed by `bench/bench-agent.sh`'s edit parser.
- Wall time (seconds)
- Quality score: 0 (broken) / 1 (partial) / 2 (complete, passes checks)

**Design principles for trustworthiness (V15-hardened):**

1. **The bench can tell us PipeMD loses.** V15's adaptive arm lost. That's the finding.
2. **Quality gates prevent "fast but wrong" from winning.** Only compare efficiency at equal quality levels (R-19).
3. **Block alignment is audited.** Scenarios are general development tasks where context helps incidentally.
4. **Variance is reported.** If WITH/WITHOUT distributions overlap, there's no effect regardless of medians.
5. **Repos are pinned to tags.** Reproducible baselines.
6. **Bench runs are excluded from any `ml/` data** (V5 contamination lesson, V15 R-23).

### Phase 2B Success Criteria

- [ ] Agent A/B bench runs ≥3 scenarios × ≥3 conditions × ≥3 repetitions
- [ ] Every scenario has an automated quality gate
- [ ] Results report all six metric axes separately with variance
- [ ] Finding is reported neutrally — whether PipeMD wins or loses on efficiency
- [ ] `pnpm bench` intrinsic harness runs in <30s (Layer 2 — still planned)
- [ ] Token ratchet catches >15% growth (Layer 2 — still planned)

---

## Phase 2C: Content Layer Investment

**Goal:** Invest in the resolvers behind the high-measured-reward blocks. This
is the positive V10/V15 agenda — where the measured value concentrates.

> **Strategic principle (V10/V15):** the block **content** is the product; the
> selection layer is secondary. The smartest ML selection never beat
> always-inject; the file's own content (`file-content`, `file-errors`) carried
> the strongest reward. Improve what you inject before you try to smartly
> select.

### 2C.1 `file-content` resolver — freshness and signal density (V10: −58.8 s, the #1 block)

The file's own recent state is the single most valuable injection. Invest in:

| Action | Detail |
|---|---|
| mtime-aware re-resolution | Re-resolve when the file changes, not on a fixed TTL alone. V5/V7 found `steps_since_lint/tsc` are top features — stale context is noise. |
| Signal density | Every line of an injected block should carry information. Trim boilerplate, keep signal. |
| Diff-aware rendering | Show what changed since the last injection, not the whole file, when the agent is iterating. |

### 2C.2 `file-errors` resolver — accuracy and speed (V10: −29.3 s, the #2 block)

Tied to Phase 2.1 (`session-validate`) and 2.2 (ecosystem syntax check). The
resolver must produce fresh, accurate errors fast.

### 2C.3 Dependency-graph leverage beyond `import-graph` (V10: −23.6 s; V7/V9 topology)

`resolveImportGraph` (`src/core/injection-engine.ts:416`) and the harvested
`ml/data/v7_dep_graph.json` are real assets. Use the graph for richer context:

| Action | Detail |
|---|---|
| Dependents-at-risk | When editing a hub file, surface its dependents (cross-file impact, not just importers). |
| Neighborhood-aware error context | When `file-errors` fires for a file, surface whether its dependents are likely affected (V9 neighborhood concept, productively). |
| Graph is project-static | No leakage risk; already built. Incremental product value on existing infrastructure. |

### 2C.4 Adaptive precision tiers (deterministic, no ML) — the "cheap middle"

Today every block renders at a fixed `max-lines` and the decision is binary
(inject full / don't). V7/V8 showed binary plateaus; V10 showed smart selection
doesn't help. But the **decision space** itself is undertapped: blocks could
render at **precision tiers**:

| Tier | Content | When |
|---|---|---|
| **T0** | off | Impossible injection (topology-filtered) or irrelevant |
| **T1** | signal one-liner ("hub: 15 importers", "3 errors") | Uncertain relevance; leaf files; low-engagement |
| **T2** | summary (top-3 items) | Moderate relevance |
| **T3** | full (today) | High relevance; actively edited hub; high-error file |

Driven **deterministically** by file role + engagement (V7 topology + V14
rewrite signal as rendering input, not selection input). This is a new core
capability — adaptive, role-aware rendering — that needs no ML. It attacks the
noise problem (cheap T1 for uncertain cases instead of all-or-nothing).

> **Discipline gate:** tiers are untested deterministically. Ship as
> `delivery: "tiered"` (opt-in), bench it prospectively (§2B.4) before making
> it a default. The V15 lesson applies: any policy change must beat the
> deterministic baseline on a real outcome, prospectively.

### 2C.5 Token budget as a first-class product lever

The one proven value of the ranker was **noise reduction / token efficiency**
(not absolute value). Make that deterministic and first-class:

| Action | Detail |
|---|---|
| Expose per-session token budget | Tunable product knob (`PMD_TOKEN_BUDGET` or `config.yml`). |
| Budget-constrained always-inject | The documented default policy (V10/V15: the evidence-supported default). |
| Tiers compose within the budget | Where deterministic curation can finally beat naive inject-all on *efficiency*. |

### Phase 2C Success Criteria

- [ ] `file-content` resolver re-resolves on mtime change (not fixed TTL)
- [ ] `import-graph` exposes dependents-at-risk for hub files
- [ ] `delivery: "tiered"` exists as opt-in, with a Layer 2 contract per tier
- [ ] Token budget knob documented and enforced
- [ ] At least one Phase 2C change validated by the §2B.4 bench (prospective)

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
| **ML-based per-block selection (`delivery: "learned"`)** on main | **Cut from main** | V10 observational: ranker worse than always-inject. V15 prospective: the adaptive boost loses at equal quality. The `learned-policy.ts` skeleton stays on main as a documented experimental stub with active-fallback; the suppress shape is untested on `experimental`. |
| **The adaptive BOOST policy** | **Cut from main** | V15 prospective A/B: the rewrite-aware boost (force re-injection when `editCount ≥ 2`) caused agent loops — rework went UP, wall time 2.1×. Do not ship. |
| Link relay persistence | Paused | Phase 4 is gated on Phase 3 proof |
| Mesh gossip protocol | Cut | Star topology suffices |
| SSH tunnel management | Cut | Users compose with existing tools |
| Team mode / RBAC | Cut | Single-user DX must be flawless first |
| Custom DSL or sandboxing | Cut | Blocks are bash scripts. No new runtime. |
| Editor integrations | Cut | Different product surface. PipeMD injects on tool calls, not keystrokes. |
| Agent fleet orchestration | **Cut** from `main`. Incubated on `experimental` per the Discipline in `docs/discipline.md`. | CAO/Weave territory on the product track; the fleet fabric (federation, dispatch, PTY) is incubated separately. |

---

## Design Principles

1. **Everything produces or delivers context.** If a feature doesn't feed the injection engine or deliver its output to an agent, it doesn't belong in PipeMD.
2. **Resolver-first.** Build resolvers (work via hooks immediately). Expose via other surfaces later.
3. **No new config files.** Everything stays in `injection.yml` and CLI flags.
4. **Read orchestration state, don't manage it.** PipeMD reads crew sessions, tasks, and git state to produce context. It doesn't assign tasks, schedule agents, or manage fleets.
5. **Every resolver must have a producer.** A resolver that reads from a cache key that nothing writes is dead code. Kill it or build the producer.
6. **Measure, don't guess.** Every block has a token cost, a latency budget, and an accuracy contract. Regressions are caught by machines, not by agents.
7. **Invest in block *content*, not ML *selection*.** (V10/V15.) The smartest selection never beat always-inject; the file's own content carried the strongest measured reward. Improve resolvers, freshness, file-aware rendering, and signal density before trying to smartly select. Whenever you add intelligence, measure the dumb baseline on the real outcome first, prospectively.
8. **Topology is config, not ML.** (V7/V15.) File role/lang is the durable deterministic signal (15× label spread). The topology filter ships as a hard file-type gate in the active baseline. No ML in the loop, no model risk.
9. **Dedup is behavior-shaping, not just an optimization.** (V15.) Forced re-injection of unchanged context can cause agent loops. Suppress unchanged content unless there's a measured reason to re-inject.
10. **Observational learnability ≠ causal policy value.** (V15 §4c.) A feature can be predictive of an outcome without being useful as a policy lever. Any ML-informed policy built from observational signals must be tested prospectively before its "direction" can be trusted.

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Agent vendors ship native injection | Medium | PipeMD's moat is cross-agent universality + named-pipe PUSH speed. |
| Solo agents dominate, crew has zero pull | Medium-High | Phases 2-2C serve solo agents perfectly. Crew is additive. |
| Named pipes break on new platforms | Low | Legacy mode (file watcher) is first-class fallback. |
| Token bloat from rich blocks | Medium | Token ratchet (Phase 2B) catches growth before it compounds. Agent bench validates that blocks earn their tokens. |
| **Static AGENTS.md performs comparably to dynamic injection on some tasks** | Medium | V15: static tied dynamic on quality + rework on scenario 05. PipeMD's value must come from freshness + signal density + cross-harness, not from "dynamic beats static" as an article of faith. Invest in the content layer (Phase 2C). |
| **Forcing an ML policy past an honest negative** | Medium | V15's discipline: honest negatives are valid outcomes. The boost is cut; the suppress shape gets one prospective test on `experimental`; if it also loses, the ML-injection line closes on main (the topology filter still ships — it's deterministic). |
| Betting on an n=5 / n=3 effect | Low | V10 (n=5) and V15 (n=3/cell) explicitly frame as signal-finding, not powered claims. Scale only on a clean win at equal quality. |
