# V13 Roadmap / Cahier des Charges — Maximize Reward R² (P1–P5)

> **Status:** Specification (drives implementation). Successor to V12.
> **Branch:** `ml`. **Predecessors:** `docs/ml-v12-cdc.md`, `ml/reports/v12_ablation.md`.
> **North star (single objective):** **push cross-product R² beyond V12** (Ridge
> 0.1275 / LightGBM 0.1877) by working five levers — the untested base family,
> target ablation, new feature categories, rich-family regularization, and model
> extraction.
> **Mandate:** move forward without any bug; every addition must clear aggregate
> monotonicity (R-9) — no forcing R² via noise.

---

## 1. Why V13 — what V12 left on the table

V12 gave every prior family a fair hearing on V11's learnable content-fit target.
The result: **topology is the only family that generalizes cross-product**
(+0.005 Ridge / +0.024 LGB); all richer families (TF-IDF, keywords, OU, Chebyshev,
FP) **hurt** cross-product — the signature of a generalization ceiling (high-dim
features overfit training projects). Final R² = 0.1275 / 0.1877.

But V12 left **five concrete levers** unexploited:
- **P1 — an untested family.** The V5b base features (38 cols: `session_len`,
  `steps_since_lint/tsc/test`, title TF-IDF, `success_rate_ewma` — the strongest
  V5/V6 signals) produced **0 valid features** due to a stale-merge bug
  (`v12_features.py:312` left-merges an old `training_data_v5.parquet` that
  doesn't align with V11's anchor universe). They were **never tested** on the
  learnable target.
- **P2 — a possibly-coarse target.** Only `D1_graded` (file-path overlap) was
  optimized. D2 (symbol/line), D3 (cosine), and composites were never checked for
  a higher R² ceiling.
- **P3 — no new feature categories.** All V12 families were ports of old ideas.
  Relevance is about *what the agent will do next* — recent-action/intent and
  semantic block↔reasoning match were never built.
- **P4 — rich families discarded un-regularized.** TF-IDF/keywords/dynamics hurt
  cross-product *as-is*; aggressive regularization / dim-reduction was never tried.
- **P5 — model under-extraction.** LightGBM (0.19) ≫ Ridge (0.13) on topology →
  real non-linear structure left on the table; no tuning was done.

V13 works all five. The objective is strictly **cross-product R²**, same
leave-one-directory-out split as V11/V12.

---

## 2. Objective & north star

**Objective:** a relevance-reward model with **cross-product R² strictly higher
than V12** (Ridge 0.1275 / LightGBM 0.1877), and a clear attribution of the gain
to the levers that worked.

**Single decision metric:** **Δ cross-product R²** (leave-one-directory-out,
identical split to V11/V12). Every keep/drop is made on this, under aggregate
monotonicity (R-9) and the +0.005 rehabilitation threshold (R-10).

**Honesty ceiling (inherited, non-negotiable):** content-fit is **relevance, not
causal value**. Raising R² = "predicts relevance better," **not** "causally more
valuable." Every result `observational_unvalidated`; bench A/B (deferred) remains
the only causal arbiter. No deployment claim.

---

## 3. Scope

**In scope** — the five levers (P1–P5), each as a reversible experiment judged on
Δ cross-product R².

**Out of scope (deferred)** — bench A/B (V14); online/serving activation; brand-
new resolvers or blocks.

---

## 4. Hygiene & "no bugs" bar (carried; V13-specific in §5)

All prior rules apply: bench-free, coverage auditor hard gate, merge-integrity,
same-regime/same-split reporting, module-import pytest, honest negatives,
**R-1 no causal claim without bench**. **V13-binding:**

- **R-9 Aggregate monotonicity on R²** — a lever is kept iff it raises the
  *combined* cross-product R² (V7 138-feat trap guard).
- **R-10 Rehabilitation threshold** — ΔR² ≥ +0.005 cross-product to keep.
- **R-11 One metric, one split** — cross-product R², leave-one-directory-out,
  identical to V11/V12. No other headline.
- **R-12 Baseline-first** — reproduce V12's R² (0.1275 / 0.1877) before any
  lever; measure all gains from the reproduced baseline (pipeline-drift guard).
- **R-13 Alignment-audit (new)** — because V12's base family silently produced 0
  features from a stale merge, V13 verifies *every* family's `step_idx` aligns
  with V11's anchors before trusting any ΔR² (protects against false negatives).

---

## 5. Specifications (the five levers)

### S1 / P1 — Base family fix + alignment audit (`ml/reward/v13_base.py`)
- **The fix is not a merge — it's a recompute.** Re-derive the V5b base features
  (`session_len`, `rel_pos`, `proj_sessions`, `steps_since_lint/tsc/test`,
  `last_*_clean`, `tests_failing`, `success_rate_ewma`, `reasoning_*`,
  `summary_files_session`, title TF-IDF) **directly on V11's anchor universe** —
  same `session_id` + tool/patch `step_idx` namespace as the simulator — not by
  left-merging a stale parquet. Reuse the V5 *builder logic*; rebuild the output
  on the V11 rows.
- **Alignment audit (R-13):** for every family (topology, dynamics, base), assert
  its `step_idx` matches V11's anchors on a sample; report any misalignment. If
  V12's "topology is the only winner" was partly a silent-misalignment artifact,
  this catches it.
- **Gate:** base produces >0 valid features; alignment audit passes for all
  families; base tested cross-product (kept iff ΔR² ≥ +0.005 under R-9).

### S2 / P2 — Target ablation (`ml/reward/v13_target.py`)
- Compute D1_graded, D2 (symbol/line overlap), D3 (cosine), and a **composite**
  (e.g., weighted mean, or the max) as candidate targets on the existing reward
  matrix.
- For each target, fit cheap+topo and record cross-product R². Pick the **most
  learnable target** (highest R²) as the V13 headline target.
- **Gate:** a target is adopted iff its cross-product R² (cheap+topo) beats
  D1_graded's 0.1275/0.1877; else stay on D1_graded.

### S3 / P3 — New feature categories (`ml/reward/v13_newfeatures.py`)
Two families targeting relevance directly (the only path to genuinely new signal):
- **Agent recent-action/intent** (not V6 activity *tempo* — the actual *action
  trajectory*): last-K (K∈{3,5}) tool one-hot, recent-files-touched set, recent-
  file ↔ target overlap (did the agent just touch files in the target's
  neighborhood?), recent co-edit-cluster, tool-transition n-grams. Rationale:
  relevance = "what the agent will do next"; recent actions are its strongest
  predictor.
- **Semantic block ↔ reasoning match** — relevance is a *match*; measure it
  semantically. Start cheap (keyword/identifier overlap between block content and
  the agent's recent reasoning text), then optionally a lightweight embedding
  cosine (sentence-transformers) if the cheap version shows signal.
- **Gate (each):** ΔR² ≥ +0.005 cross-product under R-9; leakage guarded (recent
  actions = past only; no future).

### S4 / P4 — Rich-family regularization rescue (`ml/reward/v13_regularize.py`)
- Take the V12-reverted rich families (TF-IDF, keywords, OU, Chebyshev) and apply
  **aggressive cross-product regularization**: SVD to ≤15 dims, heavy L2, strong
  feature-selection (top-N by cross-product importance). Re-test each cross-product.
- **Gate:** kept iff the *regularized* version adds ΔR² ≥ +0.005 cross-product
  beyond the running model. Expectation is low (V12 signal: they don't generalize),
  but the un-regularized test doesn't settle it. This is the cheap, definitive check.

### S5 / P5 — Model extraction + final combined model (`ml/reward/v13_model.py`)
- **LightGBM hyperparameter sweep** (n_estimators, max_depth, learning_rate,
  reg_lambda/alpha, feature/row subsampling) — the 0.06 Ridge→LGB gap says non-
  linear structure is available. Optionally **CatBoost** (native categorical
  handling — the V4 roadmap's noted option).
- Retrain the final model on the surviving feature set across all levers; report
  cross-product R² vs V12 — the single headline.
- **Cautiously** allow one small, heavily-regularized MLP probe — but ONLY if
  tree models plateau AND it beats them cross-product (the V3-GRU/V7-MLP trap:
  drop it the moment it doesn't beat LightGBM).

---

## 6. Phased plan & gates

| Phase | Lever(s) | Gate |
|---|---|---|
| **V13-0** | Reproduce V12 baseline (R-12) + base fix + alignment audit (S1). | V12 R² reproduced; base yields >0 valid features; all families aligned (R-13); base kept iff ΔR² ≥ +0.005. |
| **V13-1** | Target ablation (S2). | Most-learnable target chosen (beats D1_graded) or D1_graded retained with reason. |
| **V13-2** | New features (S3). | Each kept iff ΔR² ≥ +0.005 cross-product; leakage tests pass. |
| **V13-3** | Rich-family regularization (S4) + model tuning (S5). | Any regularized family kept iff ΔR² ≥ +0.005; MLP dropped if it doesn't beat LGB. |
| **V13-4** | Final combined model + ranked inventory + scoreboard. | **Headline: final cross-product R² vs V12's 0.1275/0.1877** — up (with lever attribution) or honest negative. |

Each phase = one commit (`feat(ml): V13 …`). Honest negatives are valid per lever
— if base overfits cross-product like TF-IDF did, it's dropped (R-9) and the
finding ("session-level features don't generalize cross-product") is recorded.

---

## 7. Acceptance criteria — Definition of Done

- V12 baseline **reproduced** before any lever (R-12).
- **Base family actually tested** (the V12 gap closed) and **alignment audited**
  across all families (R-13).
- Target ablation reported; the most-learnable target chosen with justification.
- Each lever's Δ cross-product R² reported; surviving features determined strictly
  by R-9/R-10.
- Final cross-product R² reported vs V12, **with attribution** (which levers
  delivered the gain).
- Every result `observational_unvalidated`; bench A/B named as the mandatory next
  step; no deployment claim.
- All hygiene gates pass; every new module has import + merge-integrity + leakage
  pytests.

**Honest-negative outcomes are valid:** if no lever beats V12, that is a profound
result — it means cheap+topology on D1_graded is the cross-product ceiling for
relevance, and further observational gains require the bench (more data/power) or
a fundamentally different target. Document it; do not force R².

---

## 8. Risks (and the guardrail)

| Risk | Guardrail |
|---|---|
| Base/new features overfit cross-product (like V12's rich families) | R-9 aggregate monotonicity; cross-product CV; +0.005 threshold. |
| Stale-merge bug recurs silently | R-13 alignment audit on every family before trusting ΔR². |
| Pipeline drift fakes an R² gain | R-12: reproduce V12 baseline first; gains measured from the reproduced baseline. |
| Semantic features need embeddings (heavy) | Start with cheap keyword-overlap version; add embeddings only if cheap version shows signal. |
| MLP repeat of V3-GRU/V7-MLP trap | Drop MLP the moment it doesn't beat LightGBM cross-product. |
| Confusing "predicts relevance" with "causal value" | R-1: `observational_unvalidated`; bench deferred. |
| Noise-chasing marginal R² | R-10 threshold; report per-fold variance, not just mean. |

---

## 9. Artifacts

| Path | Purpose |
|---|---|
| `docs/ml-v13-cdc.md` (this file) | V13 specification |
| `ml/reward/v13_base.py` | Base family recompute + alignment audit (S1) |
| `ml/reward/v13_target.py` | Target ablation D1/D2/D3/composite (S2) |
| `ml/reward/v13_newfeatures.py` | Recent-action + semantic match (S3) |
| `ml/reward/v13_regularize.py` | Rich-family regularization rescue (S4) |
| `ml/reward/v13_model.py` | Model tuning + final combined model (S5) |
| `ml/data/v13_feature_matrix.parquet` | Augmented matrix (base fixed + new features) |
| `ml/reports/v13_lever_report.md` | Per-lever ΔR² + verdicts + attribution |
| `ml/reports/v13_model_summary.json` | Final R² vs V12 |
| `ml/tests/test_v13_*.py` | Alignment, leakage, baseline-parity tests |

**Version tags** (auto-discovered): `v13_base`, `v13_target`, `v13_features`,
`v13_model`.

---

## 10. References

- `docs/ml-v12-cdc.md`, `ml/reports/v12_ablation.md` — V12 result + the base-BROKEN gap.
- `ml/reward/v12_features.py:312` — the stale-merge bug V13-P1 fixes.
- `ml/reward/v11_content_fit.py` — D1/D2/D3 reward definitions (P2 ablation source).
- `ml/reports/v10_postmortem.md`, `docs/ml-lessons-for-main.md` — relevance-vs-value, no-bugs bar.
- `ml/sim/v11_simulator.py` — the anchor universe every feature must align to.
