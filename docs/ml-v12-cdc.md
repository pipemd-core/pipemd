# V12 Roadmap / Cahier des Charges — Feature Re-Test to Maximize Reward R²

> **Status:** Specification (drives implementation). Successor to V11.
> **Branch:** `ml`. **Predecessors:** `docs/ml-v11-cdc.md`, `ml/reports/v11_learnability.md`.
> **North star (single objective):** **increase cross-project R²** on the V11
> content-fit reward beyond the **0.12** baseline, by re-testing **every feature
> family built in V1–V11** in V11's paradigm (dense simulation + learnable
> relevance target + rigorous cross-project CV).
> **Mandate:** move forward without any bug (the §5 bar carries over).

---

## 1. Why V12 — the fair re-test every feature never got

Across V1–V11, feature families were judged against targets that were
**degenerate (V9: random), contaminated (V5), leaky (V8), or underpowered
(V10: n=5)**. Several were **reverted as "useless"** — most notably the V6
dynamics families (OU, Chebyshev, Fokker-Planck) and parts of V8. But those
features were *never tested against a learnable target with a rigorous
methodology*. V11 changed both:

- **A learnable target** — content-fit relevance (`D1_graded`): did the block's
  content anticipate the agent's next-K actions? V11 proved this is predictable
  from *cheap* features (Ridge R²=0.12, LightGBM 0.16, **9/9 cross-project
  folds** beat baseline).
- **A rigorous methodology** — dense simulation over **real** sessions × all
  anchors × all blocks (`v11_simulator.py`, bench-free), evaluated
  **leave-one-directory-out** (cross-project, leak-free).

**V12's job is to maximize R².** It computes *every* prior feature family on
V11's simulated anchors and measures each family's **incremental cross-project
ΔR²** beyond the V11 cheap-features baseline. Families that add R² (under
aggregate monotonicity) survive; the rest are confirmed-reverted with a
definitive negative on a *learnable* target. Either way, V12 closes the book.

---

## 2. Objective & north star

**Objective:** produce a relevance-reward model with **cross-project R² strictly
higher than V11's** (Ridge 0.1223 / LightGBM 0.1627), and a **ranked inventory**
of which feature families earned their place on the learnable target.

**Single decision metric:** **Δ cross-project R²** (leave-one-directory-out).
Every keep/drop/rehabilitate verdict is made on this metric, under aggregate
monotonicity. No other headline number.

**The honesty ceiling (inherited from V11, non-negotiable):** content-fit is
**relevance, not causal value**. Raising R² means "we predict relevance better" —
**not** "we predict causal injection value." Every result is labeled
`observational_unvalidated`; the bench A/B (deferred) remains the only causal
arbiter. V12 is the strongest possible *observational* case; it does not authorize
deployment.

---

## 3. Scope

**In scope**
- Compute every prior feature family (§4) on V11's simulated anchor matrix.
- Incremental ablation: cheapest → richest, measuring ΔR² per family.
- A final relevance-reward model maximizing R² + a ranked family inventory.

**Out of scope (deferred)**
- **Bench A/B** (the causal arbiter) — V13. V12 is observational.
- **New** feature families — V12 re-tests existing ones only.
- **Online/serving activation** — none without bench validation.

---

## 4. Feature families to re-test (enumerated from the repo)

| Family | Source files | Going-in status | Hypothesis |
|---|---|---|---|
| **V11 cheap context** (file_role, file_lang, …) | `v11_model.py` | The R²=0.12 baseline | — (baseline) |
| **V7 topology A/B/C/D** (role/lang/prior, graph position, co-edit clusters, graph trajectory) | `v7_topology.py`, `v7_topology_graph.py`, `v7_dep_graph.json` | Durable signal (15× label spread) | **Largest ΔR²** expected |
| **V8 code-content TF-IDF** | `v8_code_tfidf.py` | V8 survivor (its "win" was leakage-inflated on the old label) | Strong ΔR² on the relevance target |
| **V8 code keywords (a/b/d)** | `v8_code_keywords.py` | Superseded by TF-IDF (V8) | Likely subsumed; test for any residual ΔR² |
| **Base V5b-38** (session/temporal/history/TF-IDF) | `build_training_data_v5.py` | Survivors | Partial overlap with cheap baseline; test incremental |
| **V6 OU (dynamics)** | `v6_ou.py` / `v7_ou.py` | Reverted (no signal on error-onset) | **Definitive test** — rehabilitate or confirm |
| **V6 Chebyshev (dynamics)** | `v6_traj.py` / `v7_traj.py` | Reverted/partial | Definitive test |
| **V6 Fokker-Planck (dynamics)** | `v6_hazard.py` / `v7_fp.py` | Reverted (rebuilt 2-param) | Definitive test |

The reverted V6 dynamics families are the **most important** re-test: they were
killed on bad targets; V12 gives them their first hearing on a learnable one.

---

## 5. Hygiene & "no bugs" bar (carried from V7–V11; V12-specific additions in §6)

All prior rules apply: bench-free (`is_bench_session`), temporal/cross-project
splitting, coverage auditor as hard pre-training gate (N-DOF, cumulative-vs-rate,
stream-suitability, merge-integrity), same-regime reporting, module-import
pytest, honest negatives accepted, **R-1 no causal claim without bench**.
**V12-binding additions:**

- **R-9 Aggregate monotonicity on R² (the V7 lesson hardened).** A family is kept
  iff it raises the *combined* model's cross-project R². Individual ΔR² is
  necessary but **not** sufficient — a family that looks good alone but degrades
  the whole (the V7 138-feat trap) is dropped.
- **R-10 Rehabilitation threshold.** A reverted family is "rehabilitated" only if
  it adds **ΔR² ≥ +0.005** cross-project beyond the running model. Below that is
  noise-chasing; leave it reverted.
- **R-11 One metric, one split.** The headline is **cross-project R²** (same
  leave-one-directory-out split as V11). No mixing of splits or targets in any
  comparison.

---

## 6. Specifications

### S1 — Unified feature matrix (`ml/reward/v12_features.py`)
- Load V11's simulated anchors (`ml/data/v11_rewards.parquet` + the simulator
  output) — the rows are fixed; V12 only adds feature columns.
- Compute **every** family in §4 on those exact anchors, in the V5/V9 tool/patch
  `step_idx` namespace. Reuse the existing builders verbatim — **do not re-derive
  or "fix" them** (the point is to test them as-is).
- Output `ml/data/v12_feature_matrix.parquet`: rows = V11 simulated anchors;
  columns = V11 reward (`D1_graded`, the target) + `directory` (fold key) + all
  family feature columns, namespaced by family (`topo_*`, `tfidf_*`, `ou_*`,
  `traj_*`, `fp_*`, `kw_*`, `base_*`).
- **Gate:** coverage auditor passes; merge-integrity (every family's step_idx
  namespace matches the V11 anchors); bench-free; ≤5% NaN per retained column.

### S2 — Incremental ablation, cheapest → richest (`ml/reward/v12_ablation.py`)
- Baseline = V11 cheap features alone (reproduce R²≈0.12 to confirm parity).
- Add families in priority order: **topology → code-content (TF-IDF → keywords) →
  base-V5b → dynamics (Chebyshev → FP → OU)**. After each addition, retrain
  (Ridge + LightGBM) and record **Δ cross-project R²**.
- Stop adding a family if it shows **two consecutive sub-threshold additions**
  (diminishing returns) — but still record its standalone ΔR² for the inventory.
- **Gate (per family):** kept iff combined R² increases AND ΔR² ≥ +0.005
  (R-9 + R-10); else dropped to the "confirmed-reverted" pile with its measured ΔR².

### S3 — Final model + ranked inventory (`ml/reward/v12_model.py`, `v12_inventory`)
- Retrain the final model on the surviving feature set; report cross-project R²
  vs V11 baseline (the headline).
- Produce a **ranked family inventory**: each family's standalone ΔR², incremental
  ΔR² in the combined model, compute cost, and verdict (**keep / drop /
  rehabilitate**).
- **Gate:** final model R² > V11 baseline (Ridge 0.1223 / LightGBM 0.1627),
  OR an honest negative documenting that no family beats the cheap baseline
  (which would itself be a profound finding: cheap features suffice for relevance).

### S4 — Prospective-bench handoff note (not executed)
- Document that the surviving model is `observational_unvalidated` and that the
  bench A/B (V13) is the mandatory next step to convert "predicts relevance" into
  "causally valuable." No causal claim in V12.

---

## 7. Phased plan & gates

| Phase | Deliverable | Gate |
|---|---|---|
| **V12-0** | Unified feature matrix (S1) — all families computed on V11 anchors. | Coverage auditor + merge-integrity + bench-free; ≤5% NaN/col. |
| **V12-1** | Baseline reproduction + incremental ablation (S2). | V11 baseline reproduced (R²≈0.12); each family's ΔR² recorded. |
| **V12-2** | Per-family verdicts under R-9/R-10; ranked inventory. | Surviving set determined by aggregate monotonicity; reverted V6 families get a definitive yes/no. |
| **V12-3** | Final model + scoreboard vs V11 (S3). | **Headline: final cross-project R² vs V11's 0.12** — up (and by how much) or honest negative. |

Each phase = one commit (`feat(ml): V12 …`). A gate failure → fix before
proceeding; the V12-3 honest negative ("cheap features suffice") is a valid,
important outcome — do not force R² up via noise-chasing (R-10).

---

## 8. Acceptance criteria — Definition of Done

- **Every** feature family in §4 is computed on V11's anchors and tested.
- The V11 baseline (R²≈0.12) is **reproduced** before ablation begins (parity
  check — guards against a pipeline drift that would fake an R² gain).
- A **ranked inventory** gives each family's ΔR² + verdict; the reverted V6
  families have a definitive rehabilitate/confirm-revert on the learnable target.
- The final model's **cross-project R² is reported vs V11**, up or down, with
  the surviving feature set determined by aggregate monotonicity (R-9).
- Every result labeled `observational_unvalidated`; the bench A/B named as the
  mandatory next step; no deployment claim.
- All §5 hygiene gates pass; every new module has an import + merge-integrity pytest.

**If no family beats the cheap baseline,** that is a profound, well-documented
result: it means cheap file-role/lang features suffice to predict relevance, and
the richer families (topology graphs, code embeddings, dynamics) add nothing —
which would redirect the whole product toward the simplest possible policy.

---

## 9. Risks (and the guardrail)

| Risk | Guardrail |
|---|---|
| R² gain is leakage (features computed using future info) | Reuse builders as-is; coverage auditor + merge-integrity; cross-project CV (no same-project leakage). |
| Noise-chasing (marginal ΔR² from overfit) | R-10 threshold (+0.005); aggregate monotonicity (R-9); cross-project, not random, CV. |
| Confusing "predicts relevance" with "causally valuable" | R-1: everything `observational_unvalidated`; bench deferred; no deployment claim. |
| A family's builder has a latent bug that suppresses its signal | Coverage auditor flags degenerate/1-DOF/constant features before the ablation — a family with broken features is reported as "broken (not useless)." |
| Pipeline drift fakes an R² gain vs V11 | V12-1 **reproduces** V11's baseline first; any ablation gain is measured from the reproduced baseline. |
| Diminishing returns waste compute | Stop-after-two-sub-threshold rule (S2). |

---

## 10. Artifacts

| Path | Purpose |
|---|---|
| `docs/ml-v12-cdc.md` (this file) | V12 specification |
| `ml/reward/v12_features.py` | Unified feature matrix (S1) |
| `ml/reward/v12_ablation.py` | Incremental ΔR² ablation (S2) |
| `ml/reward/v12_model.py` | Final model + ranked inventory (S3) |
| `ml/data/v12_feature_matrix.parquet` | All families on V11 anchors |
| `ml/reports/v12_ablation.md` | Per-family ΔR² + verdicts |
| `ml/reports/v12_inventory.json` | Ranked feature inventory |
| `ml/reports/v12_model_summary.json` | Final R² vs V11 |
| `ml/tests/test_v12_*.py` | Merge-integrity + baseline-parity tests |

**Version tags** (auto-discovered): `v12_features`, `v12_ablation`, `v12_model`.

---

## 11. References

- `docs/ml-v11-cdc.md`, `ml/reports/v11_learnability.md` — the paradigm + R²=0.12 baseline.
- `ml/sim/v11_simulator.py` — dense simulation (the anchor rows V12 builds on).
- `ml/reward/v11_content_fit.py` — `D1_graded` (the target).
- `ml/reports/v10_postmortem.md`, `docs/ml-lessons-for-main.md` — relevance-vs-value, no-bugs bar.
- Feature builders: `ml/features/{v6_ou,v6_traj,v6_hazard,v7_topology,v7_topology_graph,v8_code_keywords,v8_code_tfidf}.py`, `build_training_data_v5.py`.
