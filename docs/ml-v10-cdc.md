# V10 Roadmap / Cahier des Charges — The Reward Engine

> **Status:** Specification (drives implementation). A **paradigm shift** from
> supervised proxy-prediction (V1–V9) to **causal reward measurement**.
> **Branch:** `ml`. **Predecessors:** `ml/reports/v9_postmortem.md` (the
> meta-diagnosis), `docs/ml-v9-cdc.md`.
> **Mandate:** observational-first; **the reward (outcome) and the reward engine
> are the research topic.** No causal claim without bench validation (deferred).
> Move forward without any bug (the §5 bar carries over).

---

## 1. Why V10 exists — the V9 meta-diagnosis

Every label V1–V9 was a **supposition** about what success means — a proxy for
"the block helped." None measured whether the block *actually helped*. The
correlation the effort kept failing to find is real but **causal**: it lives in
the *effect of the injection on the agent's outcome*, not in predicting an event
(error onset, file-touch, resolver output). V9 proved the proxy targets are
unpredictable or artifact-prone; it did **not** prove blocks don't help.

**V10 measures the thing itself.** The research question is: *define a real,
tangible, granular reward (an outcome the injection can causally improve), build
the engine to estimate each block's causal effect on it from the existing trace,
and learn a policy from measured reward — not from proxy labels.*

This is the first version whose objective is **measurement of success**, not
prediction of a proxy. It is also the foundation that makes the precision-tier
"smart injection" idea *intelligent*: tiers become smart only when chosen by a
measured causal reward per tier (V11+), not a proxy classifier.

---

## 2. Objective & research thesis

**Primary objective:** build a **reward engine** that, for each block injected at
each anchor, estimates its **causal effect on a real outcome** — observational,
from the existing trace — and learn a reward model from those estimates.

**The research topic (explicit):** the **reward / outcome definition is itself the
core research deliverable.** V10 does not prescribe one metric as settled; it
defines candidate outcomes, implements them, and **validates** which is (a)
measurable from the trace, (b) variable (non-degenerate), and (c) causally
sensitive (it moves with injection and aligns with session-level success). The
chosen outcome is a V10 result, not an assumption.

**Out of scope (deferred):**
- **Bench A/B validation** — observational estimates are confounded; the bench is
  the only unbiased arbiter and is a later phase. V10 produces *hypotheses*.
- **Precision tiers** — V10 estimates reward for the *binary* treatment
  (injected vs not); per-tier reward `R(block, tier, context)` is V11 once a
  single-tier reward is validated.
- **Serving / online policy activation** — no activation without bench validation.

---

## 3. The engine — architecture

```
 TREATMENT            OUTCOME                CAUSAL EFFECT          POLICY
 .injection-log  →    trace steps     →      R(B,a) =             →   reward model
 (block @ anchor)     (progress after a)     E[Y|T=1,c]−E[Y|T=0,c]     R(block, context)
                      (the reward)           (propensity-matched)       (off-policy eval)
```

- **Treatment `T(B,a)`** — block B injected at anchor a (from `.injection-log`,
  aligned to the trace).
- **Outcome `Y(a)`** — a granular success metric in the window **after** a
  (the research deliverable, §S2).
- **Reward `R(B,a)`** — the causal effect, estimated by **propensity-score
  matching / IPTW** on context features (the injection policy confounds treatment).
- **Reward model** — learn `R(block, context)` from the estimates.
- **Evaluation** — retrospective **off-policy** comparison vs inject-all and the
  V6 ranker, labeled `observational_unvalidated`.

---

## 4. Hygiene & "no bugs" bar (carried from V7–V9; V10-specific additions in §5)

All prior rules apply: bench-free data (`is_bench_session` — the injection log
likely contains bench runs; exclude), temporal split, coverage auditor as hard
gate, same-regime reporting, aggregate monotonicity, module-import pytest,
honest negatives accepted. **V10-binding additions:**

- **R-1 No causal claim without bench.** Observational estimates are confounded.
  Every reward number is labeled `observational_unvalidated`. No "improves /
  prevents / value" language in the headline — only "estimated effect, pending
  bench validation." (The V7 "100% prevention" lesson, hardened.)
- **R-2 Treatment alignment is the make-or-break data step.** A pytest verifies
  sampled injection records correctly map to trace anchors (session + file +
  trigger + timestamp). A misaligned treatment invalidates everything downstream.
- **R-3 De-confounding diagnostics are mandatory.** Propensity overlap and
  covariate balance must be reported; reward estimates from regions of no overlap
  are discarded, not averaged in.
- **R-4 The outcome is a researched deliverable, not an assumption.** No reward
  model until ≥1 outcome passes the S2 validation (measurable + variable +
  causally sensitive).

---

## 5. Specifications

### S1 — Treatment alignment engine (`ml/reward/v10_treatment.py`)
- Parse `.pipemd/.injection-log/*` — each record has `[pmd-meta session=…
  trigger=…]`, `[pmd:block → /path/file]`, content, and ordering/timestamp
  (record number + file mtime; note: embedding ts in the record is a recommended
  logging improvement).
- Align each injection to a trace anchor by `(session_id, target_file, trigger,
  timestamp)` → the matching step in `steps.jsonl` (tool/patch index namespace).
- Output `ml/data/v10_treatment.parquet`: `(session_id, step_idx, block, trigger,
  target_file, injected=1)`. Build the **matched non-injection set**: anchors
  where the block was applicable but NOT injected (the controls).
- **Bench-free (R-2):** join injection session → session.directory; exclude via
  `is_bench_session`. Assert 0 bench in the output.
- **Gate:** alignment pytest — sampled injections map to the correct trace step;
  0 bench sessions; control set is non-empty.

### S2 — Outcome research (`ml/reward/v10_outcome.py`) — THE research deliverable
Define, implement, and **validate** candidate outcomes `Y(a)` measured in the
window `(a, a+W]` after the anchor:
- **(primary candidate) Forward-progress efficiency** — successful tool outcomes
  (completed edits / passing checks / files written) per token after `a`.
  Rationale: helpful context accelerates progress; tangible, granular, step-local.
- **Error-recovery cost** — tokens/steps to recover from the next error after `a`.
- **Rework / struggle** — repeated failed edits to the same file, backtrack rate.
- **Task completion** — session `summary_files`/`additions` (coarse, session-level).

**Validation gate (the research output):** an outcome is adopted only if it is
(a) measurable on ≥80% of anchors, (b) **variable** (non-degenerate; std > 0
and not dominated by a single value), and (c) **causally plausible** — it
correlates with a session-success proxy (`summary_files > 0`, lower `cost`) at
ρ ≥ 0.1, and its distribution shifts in the expected direction between injected
and matched-control anchors. **Document which outcome(s) pass and why.** This is
the single most important deliverable of V10: a real, validated reward.

### S3 — Counterfactual reward estimation (`ml/reward/v10_reward.py`)
- Estimate the **propensity** `e(a) = P(T=1 | context features)` for each anchor
  (logistic regression on V7-polished context features: file role/lang, session
  length, trigger, topology).
- **Reward** `R(B,a) = E[Y | T=1, c] − E[Y | T=0, c]` via propensity matching
  (nearest-neighbor on propensity) and/or IPTW. Per block, aggregate.
- **Diagnostics (R-3):** report propensity overlap (common-support region),
  covariate balance before/after matching, and effective sample size. Discard
  estimates outside common support.
- **Gate:** diagnostics show adequate overlap + balance; per-block reward
  estimates have sensible sign/magnitude (not dominated by a few outliers; report
  confidence intervals via bootstrap). Label everything `observational_unvalidated`.

### S4 — Reward model (`ml/reward/v10_model.py`)
- Learn `R(block, context)` — a regression from the S3 estimates onto context
  features (the same V7-polished feature set, reused).
- Cross-validate (temporal folds); report `R²` / MAE vs a constant-baseline
  (predict-the-mean) model.
- **Gate:** reward prediction beats the constant baseline out-of-sample (else the
  reward is not learnable from context — an honest negative, documented).

### S5 — Retrospective off-policy evaluation (`ml/reward/v10_policy.py`)
- Simulate the reward-model policy on the trace; estimate expected reward vs
  **inject-all** and the **V6 ranker** (off-policy / IPS estimator).
- Report as `observational_unvalidated`. **No causal/prevention/value headline**
  (R-1). The output is a hypothesis ("reward-model policy is estimated to improve
  Y by Δ, pending bench validation"), not a claim.
- **Gate:** the off-policy comparison is reported with IPS confidence intervals;
  the prospective bench is explicitly deferred.

---

## 6. Phased plan & gates

| Phase | Deliverable | Gate |
|---|---|---|
| **V10-0** | Treatment alignment (S1). | Alignment pytest (R-2); 0 bench; non-empty controls. |
| **V10-1** | Outcome research (S2) — the core research deliverable. | ≥1 outcome passes measurable+variable+causally-plausible; documented. |
| **V10-2** | Counterfactual reward R(B,a) (S3). | Propensity overlap + balance diagnostics pass (R-3); bootstrap CIs reported. |
| **V10-3** | Reward model R(block, context) (S4). | Beats constant baseline out-of-sample (temporal CV). |
| **V10-4** | Retrospective off-policy eval (S5). | IPS comparison vs inject-all + V6 reported; labeled `observational_unvalidated`; bench deferred. |

Each phase = one commit (`feat(ml): V10 …`). A gate failure → fix (rule-bound)
before proceeding; the **V10-1 outcome validation** is the make-or-break — if no
candidate outcome is causally sensitive, V10 documents the honest negative and
stops (do not force a reward model on a non-sensitive outcome).

---

## 7. Acceptance criteria — Definition of Done

- A **real, validated reward** is defined and justified (the S2 deliverable) —
  this is the headline of V10, more important than any model.
- The treatment is correctly aligned to trace anchors (R-2 pytest) and is
  bench-free.
- Per-block causal reward estimates exist with de-confounding diagnostics (R-3)
  and bootstrap confidence intervals, labeled `observational_unvalidated`.
- A reward model beats the constant baseline out-of-sample, OR an honest negative
  is documented.
- Off-policy evaluation compares to inject-all and V6 with IPS intervals —
  **no causal claim made**; bench validation is the stated next step.
- Every new module has an import + alignment/leakage pytest; all prior hygiene
  gates pass.

If no outcome is causally sensitive, or the reward is not learnable from context,
that is a legitimate, well-documented negative — the most honest possible outcome
of V10, and the correct basis for deciding whether ML belongs in PipeMD's
injection loop at all.

---

## 8. Risks (and the guardrail)

| Risk | Guardrail |
|---|---|
| **Confounding** (policy injects when it expects benefit) | Propensity matching + IPTW + diagnostics (R-3); bench validation deferred but mandatory before any claim. |
| Outcome not causally sensitive to injection (reward ≈ 0 everywhere) | S2 validation gate; honest negative; stop. |
| Treatment misalignment (the silent killer) | R-2 alignment pytest; sampled manual checks. |
| Injection log contains bench sessions | R-2: `is_bench_session` exclusion + assertion. |
| Injection log incomplete / missing ts | Record-number + mtime alignment; flag coverage; recommend logging ts in-record. |
| Small effective sample after matching | Report ESS; widen window W or pool blocks if needed; document. |
| Overclaiming observational estimates | R-1: everything labeled `observational_unvalidated`; no causal headline. |

---

## 9. Artifacts

| Path | Purpose |
|---|---|
| `docs/ml-v10-cdc.md` (this file) | V10 specification |
| `ml/reward/v10_treatment.py` | Treatment alignment (S1) |
| `ml/reward/v10_outcome.py` | Outcome research (S2) — the reward definition |
| `ml/reward/v10_reward.py` | Counterfactual reward estimation (S3) |
| `ml/reward/v10_model.py` | Reward model (S4) |
| `ml/reward/v10_policy.py` | Retrospective off-policy eval (S5) |
| `ml/data/v10_treatment.parquet` | Aligned treatment (bench-free) |
| `ml/reports/v10_outcome_research.md` | The validated reward definition + rationale |
| `ml/reports/v10_reward_estimates.*` | Per-block causal rewards + diagnostics |
| `ml/tests/test_v10_*.py` | Alignment + bench-free + leakage tests |

**Version tags** (auto-discovered): `v10_align`, `v10_outcome`, `v10_reward`,
`v10_policy`.

---

## 10. References

- `ml/reports/v9_postmortem.md` — the meta-diagnosis motivating V10.
- `.pipemd/.injection-log/*` — the treatment source (per-injection records).
- `ml/data/steps.jsonl`, `sessions.jsonl` — outcome + context source.
- `ml/etl/clean_bench_sessions.py` — bench exclusion (R-2).
- `docs/ml-v8-cdc.md` §4 — the no-bugs bar carried forward.
- `ml/features/v7_labels.py` / `v7_dep_graph.json` — context features + neighborhood (reused).
