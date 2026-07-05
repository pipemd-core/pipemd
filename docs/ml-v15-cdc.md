# V15 Roadmap / Cahier des Charges — Prospective Bench A/B of the Adaptive Policy

> **Status:** Specification (drives implementation). Successor to V14.
> **Branch:** `main`-facing (touches `src/core/`) + `ml`-side analysis.
> **Predecessors:** `docs/ml-v14-cdc.md`, `ml/reports/v14_perblock_rewards.json`.
> **Mandate:** V14's **zero-common-support** finding proved the per-block causal
> reward is structurally unobservable from simulation. The bench A/B is now the
> **only** path to causal evidence. V15 builds the first real ML-informed
> injection policy (topology + rewrite) and tests it prospectively on **one** bench
> task. Move forward without any bug; main-lane code must meet the product DoD.

---

## 1. Context — why the bench is now mandatory, not optional

Across V10–V14 the observational line mapped the relevance ceiling from two
directions (content-fit V11–V13; friction/efficiency V14) and hit a consistent
cap (R²≈0.13–0.29). Two signals proved cross-product-durable: **topology** (V7)
and **rewrite-rate** (V14, +0.0123 — the first new generalizing family since
topology). Everything else (dynamics, code-content, error channels, composite
efficiency) doesn't generalize or isn't learnable.

V14's decisive negative is the turning point: **zero common support** for every
per-block reward (`v14_perblock_rewards.json`: `n_common_support: 0` for all
blocks). Block applicability is **deterministic given context** (import-graph
fires for *all* JS/TS anchors; there is no comparable JS/TS anchor where it
*didn't* fire to serve as a control). **No observational dataset can estimate the
per-block causal effect** — not a sample-size problem, a structural one. The
bench (randomized injection) is the **only** counterfactual. V15 stops observing
and runs the experiment.

---

## 2. Objective

Implement the **adaptive** injection policy (topology filter + rewrite-aware
boost) as a real `delivery: "adaptive"` mode in PipeMD, and run a **prospective
A/B on one bench task** to answer the question 14 observational versions could
not:

> *Does adaptive injection reduce rework/tokens vs always-inject **at equal
> quality**?*

This is the first **causal, prospective** test of an ML-informed injection policy
in the effort.

---

## 3. Scope

**In scope**
- Real adaptive implementation in `src/core/` (rewrite tracker + topology filter +
  adaptive decision).
- One-task bench harness extension (per-file rework metric + `adaptive` condition).
- A 3-arm × 3-run prospective A/B on scenario `05-json-dates`.

**Out of scope (deferred)**
- Multi-task / powered statistical study (this is signal-finding on one task).
- Precision tiers as an arm (quantity-boost only this version; tiers follow-on).
- An observational reward model (V14 settled that line).

---

## 4. The implementation — a real `adaptive` mode in PipeMD

### S1 — Rewrite tracker (`src/core/`, new per-session state)
- The daemon already observes every edit. Add a per-session, per-file edit
  counter; `rewrite = edit to a file already edited this session`. Expose
  `rewrite_rate(file)` and `session_rewrite_rate` to the injection decision.
- **Session-scoped:** resets per session; a unit test verifies no cross-session
  leakage.

### S2 — Topology filter (mostly `injection.yml` + engine check)
- Per-block file-type gates: skip `syntax-check` for non-typeable files
  (`.css/.html/.md`), `file-errors`(lint) for non-lintable, etc. This is the V7
  15× label-spread signal turned into a hard, deterministic filter. Mostly config
  + a small engine check. Zero ML.

### S3 — Adaptive decision (`src/core/injection-engine.ts`, new branch beside
`active`/`learned`, which live at `:803-823`)
- At each trigger: apply the topology filter (skip impossible blocks), then
  **boost** injection where `rewrite_rate(target_file)` is high (the agent is
  iterating/struggling on it → likely needs context): ensure the relevant
  error/dependency blocks fire. For low-rewrite/low-need anchors, inject the cheap
  default.
- **Quantity-boost only** this version (no precision tiers yet).

**Main-lane DoD (binding — this is product code):** `pnpm tsc --noEmit` clean,
`pnpm eslint src/` clean, unit tests in `test:unit`.

---

## 5. The one-task prospective bench

**Scenario:** `05-json-dames` (hono **TypeScript**, real bug, exploration-heavy) —
TS = where topology/rewrite signals are richest; exploration-heavy = context
injection actually matters. *(Alt: `01-response-cache`.)*

**Three arms, 3 runs each = 9 runs:**
| Arm | Config | Role |
|---|---|---|
| **A — always-inject** | `delivery: "active"` | the observational-best baseline (V10/V14) |
| **B — adaptive** | `delivery: "adaptive"` | the ML-informed policy (topology + rewrite) |
| **C — static** | hand-written AGENTS.md | the realistic product-relevance anchor (WITH-vs-STATIC) |

**Measurement:**
- **Quality** — native gate (tsc + vitest), grade 0–2. **Must be equal** before
  efficiency is compared (the `bench/rubric.md` rule).
- **Rework** — **new bench metric**: per-file re-edits (rewrites) within a run.
  This is V14's validated learnable channel and the **primary outcome**.
- **Efficiency (secondary)** — tokens, tool_calls, wall_ms, reads (existing bench
  metrics).

**Bench harness extension (S4):**
- Add per-file rewrite counting to `bench/bench-agent.sh`'s edit parser
  (~line 233): re-edits to the same filePath within a run.
- Add an `adaptive` condition path that sets `delivery: "adaptive"` in the
  worktree `.pipemd/config.yml` before `pmd start`.

---

## 6. Hygiene & binding rules

All prior rules apply: bench-free, coverage auditor where relevant, same-regime
reporting, module-import/unit tests, honest negatives. **V15-binding:**

- **R-18 Main-lane DoD.** `src/core/` changes must pass `pnpm tsc --noEmit`,
  `pnpm eslint src/`, and add unit tests in `test:unit`. This is product code.
- **R-19 Equal-quality comparison (`rubric.md`).** Rework/efficiency is compared
  **only** between arms at the **same quality grade**. A faster adaptive run that
  fails the gate does NOT beat a passing always-inject run.
- **R-20 One-task = signal-finding.** This is **not** a powered claim. A clean
  adaptive win at equal quality = first causal evidence (justify scaling). A null
  = not-beaten-*here* (not proof of uselessness). No product claim from 9 runs.
- **R-21 No observational causal language.** Only the prospective A/B difference
  is causal evidence. Nothing is called "prevents/improves" except the measured
  A/B delta.
- **R-22 Rewrite tracker is session-scoped** — a unit test verifies no
  cross-session leakage and that rewrites reset per session.
- **R-23 Bench self-exclusion** — the bench's own runs must not contaminate any
  `ml/` data (the V5 contamination lesson).

---

## 7. Phased plan & gates

| Phase | Deliverable | Gate |
|---|---|---|
| **V15-0** | Adaptive implementation (S1–S3). | tsc + eslint clean; unit tests for rewrite tracker (R-22) + topology filter. |
| **V15-1** | Bench harness extension (S4): rework metric + `adaptive` condition. | Rework counted correctly on a dry run; adaptive condition wires config. |
| **V15-2** | Run the one-task A/B (9 runs). | 9 runs complete; quality grades + rework + efficiency recorded. |
| **V15-3** | Analysis + verdict. | Same-quality comparison (adaptive rework/tokens vs always-inject); one-paragraph causal-direction verdict. |

Each phase = one commit (`feat(core): V15 …` / `feat(ml): V15 …`).

---

## 8. Acceptance criteria — Definition of Done

- Adaptive mode ships **main-lane-clean** (tsc/eslint/tests).
- 9 runs complete on scenario 05 with quality + rework + efficiency recorded.
- **Honest one-task framing** (R-20): signal-finding, not a powered claim.
- **Equal-quality comparison** reported (R-19): does adaptive beat always-inject
  on rework at equal grade?
- No observational metric called causal (R-21); only the A/B delta is.
- One-paragraph verdict: is this the first causal evidence the ML-informed policy
  adds value, or does always-inject still win?

**Honest-negative acceptance:** if adaptive does not beat always-inject at equal
quality, that is the prospective confirmation of V10/V14's observational finding
(always-inject is the best-supported policy) — a valid, important result. Do not
force a win.

---

## 9. Risks

| Risk | Guardrail |
|---|---|
| One task is underpowered | R-20: explicit signal-finding; report per-run, scale only on a clean win. |
| Adaptive hurts quality (over/under-inject) | R-19: quality must be equal; a quality drop = policy failure regardless of efficiency. |
| Rework metric noise (3 runs/cell) | Report per-run values, not just means. |
| Rewrite tracker cross-session leak | R-22: session-scoped unit test. |
| Bench self-contamination | R-23: exclude bench runs from ml/ data. |
| Adaptive complexity introduces a main-lane bug | R-18: full DoD; the bench itself is the integration test. |

---

## 10. Artifacts

| Path | Purpose |
|---|---|
| `docs/ml-v15-cdc.md` (this file) | V15 specification |
| `src/core/` (rewrite tracker + adaptive branch) | The real implementation (S1–S3) |
| `bench/bench-agent.sh` (rework metric + adaptive condition) | Bench harness extension (S4) |
| `ml/reports/v15_bench_results.json` / `.md` | The 9-run A/B results + verdict |
| `tests/test-adaptive.ts` (or similar) | Rewrite-tracker + topology-filter unit tests |

**Version tags** (auto-discovered): `v15_impl`, `v15_bench`, `v15_results`.

---

## 11. References

- `ml/reports/v14_perblock_rewards.json` — the zero-common-support proof (why the bench is mandatory).
- `docs/ml-v14-cdc.md` — rewrite as the durable signal (+0.0123).
- `docs/ml-v7-cdc.md` §12 — topology (the other durable signal).
- `src/core/injection-engine.ts:803-823` — delivery routing (where `adaptive` is added).
- `bench/bench-agent.sh`, `bench/rubric.md`, `bench/baselines.json` — the harness, equal-quality rule, scenario 05.
- `ml/reports/v10_postmortem.md`, `docs/ml-lessons-for-main.md` — always-inject as the evidence-supported default; causal-requires-bench.
