# V7 Cahier des Charges — Step-Level Error-Onset Prediction for Proactive Injection

> **Status:** Specification (drives implementation). Supersedes the V6 feature
> postmortems as the authoritative direction for the transformer_trade-derived
> feature families.
> **Branch:** `ml`. **Predecessor:** `ML_ROADMAP.md` § V6, `ml/reports/v6_second_pass_postmortem.md`.
> **Source of the ported ideas (read-only reference):** `/home/ivann/repos/transformer_trade/include/framework/features/`.

---

## 1. Context & diagnosis — why V6's features failed, and why V7 is different

V6 ported three transformer_trade feature families (Ornstein-Uhlenbeck,
Chebyshev trajectory, Fokker-Planck) and they were **reverted as useless** under
the session-level injection label. A second-pass audit proved the features were
correctly attached and healthy, but a feature-by-feature reading against the
originals revealed **four distinct root causes** — none of which is "the ideas
don't apply to PipeMD":

1. **Wrong target.** The features are forward projections of an activity stream,
   designed to predict the *forward state of that stream*. They were judged
   against session-level injection **utility** (93.6% session-constant) — a
   different quantity. Aimed at **step-level error onset** (Regime T), five of
   them fired (`cint_c1` +0.0101, `cerr_proj_std`, `err_innovation`,
   `reason_half_life`, `cerr_r2`).
2. **Wrong input series (Chebyshev).** Polynomials were fit to **cumulative
   sums** (monotone → `r2` always ≈0.9 → zero information). The original fits
   *z-scored noisy price*. Evidence: `cerr_r2` mean 0.906, dominant 56.8%.
3. **Wrong stream (OU).** OU was fit to `error_rate` — a sparse bounded
   proportion (4.8% positive) — where AR(1) degenerates. Evidence:
   `err_half_life` *hurts* (ΔAUC −0.0322) while the volume-like
   `reason_half_life` *helps* (+0.0037).
4. **Degenerate build (Fokker-Planck).** Built as a 1-parameter Geometric(p) —
   8 bins from one scalar = 1 degree of freedom. The original is a
   **2-parameter** (drift μ + vol σ) forward PDF. The bins collapsed to
   redundancy (|corr|>0.95).

Plus two **fidelity losses** that discarded the most predictive signals: OU
dropped `curr_dev_stat` (deviation from equilibrium) and multi-window;
Chebyshev replaced covariance-based `proj_std` with a crude heuristic and
dropped `time_to_peak` / coefficient momentum.

**V7 thesis:** the features are sound; the port was mis-aimed and sloppy. V7
re-targets them at **step-level error onset** (the context the
`file-errors` / `syntax-check` / `test-failures` blocks inject), re-builds them
faithfully on the right streams, and wires a value-aware **proactive injection**
decision rule. This is a **paradigm shift**: from "rank blocks at trigger
points" to "predict imminent errors and inject just-in-time context to prevent
them."

---

## 2. Objectives

**Primary:** Build a step-level error-onset predictor, per error type and
horizon, that is accurate enough (target AUC ≥ 0.75) to drive **proactive**
context injection — injecting `file-errors`/`syntax-check`/`test-failures`
content *before* an error manifests, not reactively at trigger points.

**Secondary:** Deliver the three feature families as **faithful** ports (right
streams, right series, 2-param distribution, restored variants) and harden the
ML engine so this class of mis-aim/degeneracy cannot recur.

**Non-goal:** Replace the session-level injection ranker (`v6_labels`). V7
predicts errors; the ranker still governs budget. The two compose (§ S6).

---

## 3. Scope

**In scope**
- Separated, step-level, multi-horizon error-onset labels (lint / type-compile /
  test) — § S1.
- Faithful re-implementation of OU, Chebyshev, and Fokker-Planck — § S3–S5.
- A value-aware proactive-injection decision rule — § S6.
- Engine hardening: stream-suitability auditor, N-DOF redundancy detector,
  cumulative-vs-rate guard — § S7.
- A prospective validation that proactive injection actually prevents errors
  (bench-style, not just retrospective AUC).

**Out of scope (deferred)**
- Neural sequence ranker. V6 showed LightGBM beats MLP for session-level; V7
  re-tests a sequence model only if step-level AUC plateaus below 0.75 with
  the faithful feature set.
- New blocks/triggers. V7 predicts onset for the *existing* three error blocks.
- Production activation (ONNX/TS wiring). V7 ships research artifacts + the
  decision rule; serve-parity is a separate gate after V7 proves retrospective
  value (mirrors the RFC staging).

---

## 4. Hygiene principles (carried forward from V6 — non-negotiable)

1. **Bench-free training data.** The ETL excludes bench sessions permanently
   (`extract_opencode_db.py` → `is_bench_session`). Never delete a non-bench
   session; `ml/etl/clean_bench_sessions.py` is the only sanctioned tool.
2. **Temporal walk-forward split + embargo.** All V7 training uses the
   `--split temporal` path; embargo gap ≥ max horizon.
3. **Coverage auditor is a hard pre-training gate.** No model trains until
   `ml/eval/coverage_auditor.py` passes on the dataset. V7 *extends* it (§ S7).
4. **Merge-integrity check.** Every external feature builder must pass
   `check_merge_integrity` (its `(session_id, step_idx)` namespace matches the
   training data's) before evaluation.
5. **Dual-regime honesty.** Even though V7's primary target is step-level
   (Regime T), every feature is also reported under the session-level label
   (Regime S) so the comparison to V6 stays honest.
6. **One-family-at-a-time, permutation-gated.** Add a family, audit, train,
   measure permutation importance; keep only net-positive contributions.
   Revert-with-postmortem on failure, citing auditor output + dual-regime
   numbers (not hand-waves).
7. **No leakage.** Labels computed from forward steps; features from
   `≤ t` only; `RollingState` updated after feature emission; grounding columns
   in `NON_FEATURE_COLS`.
8. **The gate benchmark is `ml/eval/version_compare.py`.** Re-run after every
   retrain; the scoreboard is the single source of truth.

---

## 5. The paradigm shift — proactive injection

```
 V6 (reactive):   trigger fires → rank blocks by session-level P(useful) → inject under budget
 V7 (proactive):  at every step t → P(error-type X within K) per type/horizon
                          → inject block X when  P · value(X)  >  token_cost(X) · noise_penalty
```

The ranker math is reused (`horizon_eval.py:165-196`); the **value** changes
from "block was consumed" to "error prevented." A prospective bench measures
whether injection at `t` actually reduces errors in `(t, t+K]`.

---

## 6. Specifications

### S1 — Separated, step-level, multi-horizon error-onset labels

**Builder:** `ml/features/v7_labels.py` (new; supersedes the blended Regime-T
label that collapsed file-errors and syntax-check into one).

**Label definition** (per anchor step `t`, error type `X`, horizon `K`):

> `label_X_K(t) = 1` iff any tool/patch step in `(t, t+K]` emits output matching
>  the error-type-`X` detector; else `0`.

This **decouples the label from "did a formal check run"** (the V5 trap that
produced 0% positives) and ties it to "did an error manifest in output" — the
quantity proactive injection tries to prevent.

**Error-type detectors** (regex families, reuse/extend `v6_ou.py:144`):
| Type `X` | Detector (match against `state_output`) | Block injected |
|---|---|---|
| `lint` | `eslint`, `ruff`, `no-unused-vars`, `flake8`, lint rule codes | `file-errors` |
| `type` | `error TS\d{4}`, `Type .* is not assignable`, `Cannot find module`, `Argument of type` | `syntax-check` |
| `test` | `FAIL`, `Tests:.*failed`, `AssertionError`, `Traceback`, `✕`, `jest`/`vitest` failure lines | `test-failures` |

**Horizons:** `K ∈ {5, 10, 20, 40}` steps (tool/patch-indexed, same namespace as
the training `step_idx`). Multi-horizon so the model learns the term structure
of error onset.

**Non-degeneracy gate:** each `(X, K)` label must have positive rate ≥ 3% on
clean data; if below, widen `K` or merge with a neighbor type and document why.
(Measured V6 Regime-T baseline: ~4.8% at K=20 — comfortably non-degenerate.)

**Leakage:** labels are computed from steps `> t`; features from steps `≤ t`.

**Acceptance:** `v7_labels` summary shows 3 types × 4 horizons, each ≥3%
positive, step-varying (mean unique labels per session > 1.5).

---

### S2 — Activity streams (inputs to all stochastic-process features)

**Principle:** features that assume a continuous, strictly-positive,
mean-reverting process (OU, Fokker-Planck) must be fed such streams. The V6
mistake was feeding sparse/bounded streams.

**Approved streams** (all computed from the tool/patch trace, indexed by the
training `step_idx`):
| Stream | Definition | Why suitable |
|---|---|---|
| `reasoning_intensity` | EWMA(half-life 5) of reasoning text length | continuous-positive, mean-reverting |
| `log_dt` | `log(1 + seconds since previous tool step)` | continuous-positive, flow tempo |
| `edit_volume` | bytes changed by the most recent edit/patch | continuous-positive, work intensity |
| `tool_entropy` | rolling Shannon entropy of tool-name histogram (window 20) | continuous-positive, exploratory vs focused |

**Forbidden streams** (justified by V6 evidence):
- `error_rate` (sparse bounded proportion → AR(1) degenerates; `err_half_life`
  hurt at −0.0322).
- `tool_diversity` as a ratio in [0,1] (bounded → poor for log/OU).

**Stream-suitability check (part of § S7):** each stream must pass an
autocorrelation + sparsity + boundedness test before being accepted as input to
OU/FP. Sparse error counts are routed only to Chebyshev-rate features (S4) and
the count-distribution feature (S5 alt).

---

### S3 — Faithful OU re-implementation → `v7_ou`

**Reference:** `volume_distribution_feature_builder.hpp` (read line-by-line).
**Fixes vs V6 `v6_ou.py`:** right streams (S2), multi-window, multi-horizon,
exp-weights, restored `curr_dev_stat`/`snr_future`/`uncert`/squashed.

**Configuration** (mirror the original defaults):
- `windows = [10, 30, 60]` (multi-window; "let the model learn attention over regimes")
- `time_horizons = [5, 10, 20]` (aligned to S1 label horizons)
- `ridge_lambda_per_point = 1e-3`, `b_min=0.01`, `b_max=0.98`, `theta_min=1e-3`
- `mu_shrink = 0.5`, **`use_exp_weights = true`**, `half_life_frac = 0.33`
- `add_squashed_variants = true`

**Emitted features** (per stream × window × horizon — full restored set):
- Per `(w)`: `curr_dev_stat`, `innovation`, `half_life` (+ `_sq` squashed).
- Per `(w,h)`: `z_future`, `snr_future`, `uncert` (+ `_sq`).

**Streams:** the four S2 streams. (3 windows × {1 + 2 horizons} × ~5 features ×
4 streams ≈ a controlled ~120 features; the auditor prunes redundancy.)

**Hard requirements:**
- Exp-weighted regression (V6 used equal weights — fidelity loss).
- `curr_dev_stat` MUST be emitted (V6 dropped it; it is the deviation-from-
  equilibrium signal, usually the most predictive OU feature).
- Multi-window (V6 used one).

---

### S4 — Faithful Chebyshev re-implementation → `v7_traj`

**Reference:** `polynomial_feature_builder_V3.hpp`.
**Core fix vs V6 `v6_traj.py`:** fit polynomials to **rolling rates / running
averages**, NEVER cumulative sums.

**Series to fit** (each over rolling windows):
- `rolling_error_rate` (window 20) — the noisy per-step rate, NOT `cum_err`.
- `rolling_reasoning_intensity` (window 20).
- `rolling_edit_rate` (window 20).

**Rationale:** cumulative sums are monotone → `r2` always ≈0.9 (degenerate,
proven: `cerr_r2` mean 0.906). Rolling rates are genuinely noisy → `r2`
("trendiness") becomes informative. The V6 winner `cint_c1` already
half-proves this (it fit a *running average*, not a raw sum).

**Configuration:**
- `windows = [20, 60]`, `degree = 3`, Chebyshev basis (extrapolation-stable).

**Emitted features** (per series × window — restored set):
- `c1..c4` (shape coefficients: slope, curvature, skew, inflection).
- `r2` (trendiness — now meaningful on rates).
- `proj_slope`, **`proj_std`** (forecast CI from the **regression covariance
  matrix** — V6 used a crude `resid_std·√(1+δ)` heuristic; restore the real
  covariance propagation).
- `time_to_peak` (steps until the fitted curve's extremum — exhaustion signal;
  V6 dropped it).
- `coeff_diff` (change in `c1` over `P` steps — shape momentum; V6 dropped it).
- `prob_cross_recent_high` (analog of `prob_cross_donchian`: probability the
  projection crosses a recent rolling max — breakout/acceleration signal).

**Hard requirements:**
- Never fit to cumulative sums. The auditor's cumulative-vs-rate guard (§ S7)
  must pass.
- `proj_std` must be covariance-derived, not heuristic.

---

### S5 — Faithful Fokker-Planck re-implementation → `v7_fp` (true 2-parameter)

**Reference:** `fokker_planck_feature_builder.hpp`.
**Core fix vs V6 `v6_hazard.py`:** the V6 hazard was a 1-parameter
`Geometric(p)` — 8 bins from one scalar → 1 degree of freedom → collapsed to
redundancy. V7 builds a **2-parameter forward distribution**.

**Primary build — OU forward-PDF (continuous-state analog of the price PDF):**
For each S2 stream, take the OU fit from S3 `(θ, σ)` at step `t`. The OU
process has a known forward Gaussian transition for the activity level:
`X_{t+h} ~ N( μ_proj(h), σ_proj²(h) )` with
`μ_proj = X_t·e^{−θh} + μ(1−e^{−θh})`,
`σ_proj² = (σ²/(2θ))(1−e^{−2θh})`. Discretize this forward PDF into **16 bins
centered on the current `X_t`, spaced by `σ`** (faithful to the original's
bin construction, `fokker_planck_feature_builder.hpp:127-133`). The bin vector
is a function of **both** θ (direction/mean-reversion) and σ (uncertainty) →
genuine multi-DOF shape.

**Horizons:** `[5, 10, 20]` (aligned to S1).

**Per-(stream, horizon):** 16 bin probabilities.

**Alternative build (count regime) — Negative Binomial:** for the
`rolling_error_rate` stream specifically, model "number of errors in next K
steps" as `NegBinom(mean=rate·K, dispersion=φ)` where `φ` is estimated from
recent overdispersion. 2 params (mean + dispersion) → non-degenerate. Use this
if the continuous OU-PDF on the error stream is unstable.

**Hard requirements:**
- The emitted bin/distribution vector MUST have ≥ 2 effective degrees of freedom
  (verified by the N-DOF detector, § S7). A 1-param distribution fails the gate
  by construction.
- Bins centered on the current value, spaced by the stream's σ.

---

### S6 — Value-aware proactive-injection decision rule

**Module:** `ml/eval/proactive_eval.py` (new; mirrors `horizon_eval.py` but for
the proactive paradigm).

**Decision at step `t`:** for each error block `B` (with error type `X_B` and
token cost `C_B`), choose the horizon `K*` maximizing expected net value:

```
net_value(B, K) = P(label_X_K(t)=1) · V_prevent(X)  −  C_B · λ_noise − C_B · λ_budget
inject(B) iff max_K net_value(B, K) > 0   AND   within global token budget
```

- `V_prevent(X)` — value of preventing an error of type `X` (calibrate from the
  V6 retro priors / `retro_validation.py`; e.g., preventing a type error > a
  lint warning).
- `λ_noise`, `λ_budget` — reuse the `horizon_eval.py` ranker constants as
  starting points (PROB_FLOOR, GAMMA, etc.); tune on a held-out fold.

**Evaluation metrics** (the V7 scoreboard):
- **Error-prevention rate:** of errors that would have occurred in `(t, t+K]`,
  the fraction for which the relevant block was injected at `t`.
- **Noise rate / tokens-per-decision** (as V6).
- **Net useful value per decision** (primary headline).
- A **prospective bench cell** (§ 7, Phase 4): run an agent with proactive
  injection on a benchmark scenario and measure whether errors actually
  decrease vs the reactive baseline.

---

### S7 — Engine hardening (extends the V6 auditor)

Extend `ml/eval/coverage_auditor.py` with three checks that would have caught
the V6 failures directly:

1. **Stream-suitability check.** For each stream fed to OU/FP: report
   autocorrelation(lag-1), sparsity (% zero), and boundedness. Flag sparse
   bounded streams (e.g., `error_rate`) as **unsuitable** for stochastic-process
   features; route them only to Chebyshev-rate and count-distribution builders.
2. **N-DOF redundancy detector.** Beyond pairwise |corr|, compute the effective
   rank of any emitted feature *group* (e.g., the 16 FP bins). Fail the group if
   its effective rank < ⌈size/4⌉ (catches the 8-bin-from-1-scalar collapse).
3. **Cumulative-vs-rate guard.** Flag any polynomial fit whose input has
   monotonicity > 0.98 (cumulative-sum degeneracy → `r2` uninformative).

Each check emits a pass/fail row in `coverage_audit_<version>.md` and is a hard
pre-training gate (§ 4.3).

---

## 7. Phased implementation & gates

| Phase | Deliverable | Gate (must pass to proceed) |
|---|---|---|
| **P0** | `v7_labels.py` (S1); auditor extensions (S7). | 3 types × 4 horizons all ≥3% positive, step-varying; auditor's 3 new checks implemented + unit-tested. |
| **P1** | `v7_ou.py` faithful re-port (S2+S3). | Stream-suitability passes for all 4 streams; merge-integrity passes; **dual-regime**: at least one OU feature (e.g. `curr_dev_stat` or `reason_*_innovation`) shows Regime-T permutation ΔAUC > 0.002. |
| **P2** | `v7_traj.py` faithful re-port (S4). | Cumulative-vs-rate guard passes (no cumulative-sum fits); covariance-based `proj_std`; ≥1 trajectory feature passes Regime-T gate. |
| **P3** | `v7_fp.py` 2-param build (S5). | N-DOF detector confirms ≥2 effective DOF in the bin vector; ≥1 distribution feature passes Regime-T gate. |
| **P4** | Combined `v7_combined` + `proactive_eval.py` (S6); prospective bench cell. | **Headline gate: step-level error-onset AUC ≥ 0.75** for at least one error type; prospective bench shows error reduction vs reactive baseline. |
| **P5** | Trim progressively (permutation); final scoreboard; CDC closure. | Minimal feature set retained; `version_compare.md` shows v7 deltas; AUC ≥ 0.75 holds after trim. |

Each phase is one commit (repo style: `feat(ml): V7 …`). A phase that fails its
gate is reverted-with-postmortem citing the auditor + dual-regime evidence.

---

## 8. Acceptance criteria — Definition of Done

- All three families re-implemented faithfully (S3–S5), each passing its
  phase gate.
- Separated labels (S1) non-degenerate for all 3 types × 4 horizons.
- Step-level **error-onset AUC ≥ 0.75** for ≥1 error type on clean, temporal-split data.
- Auditor extensions (S7) in place and gating every training.
- Proactive decision rule (S6) + a prospective bench cell showing proactive
  injection reduces errors vs the reactive baseline.
- `ml/reports/version_compare.md` shows the v7 rows with deltas vs `v6_labels`.
- `ml/.venv/bin/python ml/eval/coverage_auditor.py` and `version_compare.py`
  run clean; `pnpm tsc --noEmit` + `pnpm eslint src/` unaffected (research lane).
- Postmortems (if any feature is dropped) cite auditor output + dual-regime
  numbers — never hand-waves.

If the AUC ≥ 0.75 headline is not met after the faithful re-port, the honest
negative is documented and serve-parity/ONNX activation is **not** pursued
(per the RFC staging and the V3-GRU lesson).

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Error-onset labels still too sparse for some (type, K) | Non-degeneracy gate (S1); widen K or merge types with recorded reason. |
| OU unstable on short sessions | Min-history floor; per-session skip (as the original's NaN policy); report coverage. |
| FP 2-param bin vector still collapses to low rank | N-DOF detector fails it → fall back to Negative Binomial count build (S5 alt). |
| AUC plateaus below 0.75 | That is a legitimate negative; document and do not activate serving. Re-test a sequence model only as a documented extension. |
| Proactive injection causes over-injection (noise) | Value-aware rule with `λ_noise`/budget cap; measure net useful value, not raw prevention rate. |
| Prospective bench confounds (agent variance) | Multiple runs per cell; compare at equal quality grade (bench `rubric.md` discipline). |
| Re-introducing a merge-namespace bug | Merge-integrity check (§ 4.4) is a hard gate on every builder. |

---

## 10. Artifact manifest

| Path | Purpose |
|---|---|
| `docs/ml-v7-cdc.md` (this file) | V7 specification |
| `ml/features/v7_labels.py` | Separated error-onset labels (S1) |
| `ml/features/v7_ou.py` | Faithful OU re-port (S3) — **replaces** `v6_ou.py` |
| `ml/features/v7_traj.py` | Faithful Chebyshev re-port (S4) — **replaces** `v6_traj.py` |
| `ml/features/v7_fp.py` | 2-param Fokker-Planck re-port (S5) — **replaces** `v6_hazard.py` |
| `ml/eval/proactive_eval.py` | Value-aware proactive-injection rule + eval (S6) |
| `ml/eval/coverage_auditor.py` | Extended: stream-suitability + N-DOF + cumulative-vs-rate (S7) |
| `ml/reports/v7_*_summary.json`, `v7_*_horizon_eval.json` | Per-phase artifacts (auto-discovered by `version_compare.py`) |
| `ml/reports/v7_*_postmortem.md` | Per-family postmortems if reverted |
| `/home/ivann/repos/transformer_trade/include/framework/features/*.hpp` | Source of the ported ideas (read-only) |

**Version tags** (auto-discovered by the gate benchmark): `v7_labels`,
`v7_ou`, `v7_traj`, `v7_fp`, `v7_combined`, `v7_proactive`.

---

## 11. References

- `ML_ROADMAP.md` § V6 — predecessor plan; § "CRITICAL DATA-HYGIENE ISSUE".
- `ml/reports/v6_second_pass_postmortem.md` — the corrected V6 analysis this CDC
  responds to.
- `ml/eval/horizon_eval.py:45-196` — ranker constants reused by S6.
- transformer_trade originals: `volume_distribution_feature_builder.hpp`,
  `polynomial_feature_builder_V3.hpp`, `fokker_planck_feature_builder.hpp`.
- `bench/rubric.md` — quality-grade discipline for the prospective cell (Phase 4).

---

## 12. Topology feature family (S8) — added after V7 baseline

> **Origin:** a research hypothesis raised after the V7 baseline was specified:
> the dominant predictor of both error onset and injection value is *which file
> is being edited and where it sits in the dependency graph* — not the activity
> tempo modeled by S3–S5. V6/V7 modeled the wrong data. This section adds the
> missing family. **It is likely the highest-impact family and should be the
> first V7 experiment** (Tier A below is cheap and decisive).

### 12.1 Evidence (measured, not assumed)

Cross-tab of the V6 label rate by edited-file extension (clean data,
`training_data_v6.parquet`):

| Block | Highest ext (rate) | Lowest ext (rate) | Spread |
|---|---|---|---|
| `file-errors` | `.mjs` 0.67 | `.json` 0.045 | **15×** |
| `syntax-check` | `.mjs` 0.72, `.sh` 0.64 | `.css` 0.18 | **4×** |
| `test-failures` | `.md` 0.13, `.tsx` 0.12 | `.none` 0.037 | **3.5×** |

Decisive point: **the V5b 38-feature production model dropped `target_ext`
entirely** (only `hist1_ext` and `target_dir_depth` survived). So the *current
file's type/role* — the single strongest available predictor — has been absent
from the model. The agent's behavior is encoded in file-edit **topology**, in
four layers of increasing richness.

### 12.2 Real data source — reuse the runtime `resolveImportGraph` resolver

**Do not re-implement graph parsing.** Harvest the **actual** resolver output
that PipeMD already produces at injection time:

- **Cache location:** `.pipemd/cache/sources/import-graph:%2F<encoded-abs-path>.json`
  (filename = key with `/`→`%2F`, see `src/core/cache.ts:55-64`).
- **Entry shape:** `{key, data, hash, timestamp, ttl}` where `data` is the
  resolver's text — an `"Imports:\n  <path> → <symbols>\n…"` section and/or an
  `"Imported by:\n  <consumer> → <symbols>\n…"` section (`src/core/injection-engine.ts:480-535`).
- **Real data already on disk:** 60 resolved entries exist today (proof the
  source is live).
- **Resolver scope & limits (design around them):** JS/TS only (`.ts/.tsx/.js/.jsx/.mjs/.cjs`); returns "" for all other extensions; capped at 15 edges per direction per file; gives **both directions** (importers = in-edges, imports = out-edges) with imported **symbols**.

**Harvest + warm-up contract** (`ml/features/v7_topology_graph.py`, new):
1. Read every `import-graph:*` cache entry; parse the two sections into a
   directed edge set (`consumer → target` with symbol list). This is the **real**
   dependency graph from real sessions.
2. **Coverage warm-up:** for source files that appear in the training trace but
   have no cache entry, invoke the **same runtime resolver** to populate real
   entries before feature extraction. Invocation path: drive the existing
   resolver via the daemon/pipe (the same code path the `import-graph` block
   uses), or a small TS harness that calls `resolveImportGraph` over the file
   union. **Never** substitute a Python re-implementation for the real resolver
   output — the point is real data.
3. Persist the assembled graph once as `ml/data/v7_dep_graph.json` (adjacency +
   symbols); topology features read from it deterministically.

**Non-JS/TS files:** receive no graph edges from the resolver → their topology
features are **Tier A (role/type) only**; graph features (Tier B) are
`NaN`/0-filled and the auditor must flag the coverage split (S7 stream-suitability
analog). Document the JS/TS-only limitation in the model card.

### 12.3 Specification S8 — topology features

**Module:** `ml/features/v7_topology.py` (new), feeding `v7_topology_graph.py`.

**Tier A — file role/type (cheap; the decisive probe).** Derived from path +
extension only; available for every edit regardless of language:
- `target_role` ∈ {source, test, config, style, doc, script, data, build}.
- `target_lang` ∈ {ts, py, go, lua, css, markup, data, shell, none}.
- `error_impossibility_prior` per `(role, error-type)` — bake the §12.1
  cross-tab in directly (e.g. `role=style` → P(type error)≈0). This is a strong
  inductive bias LightGBM cannot recover cleanly from sparse one-hot `target_ext`.

**Tier B — dependency-graph position (from the real resolver graph).** Per edited
file `f`, computed over the harvested directed graph:
- `target_in_degree` (number of importers), `target_out_degree` (number of imports).
- `target_is_hub` (top-quartile in-degree), `target_is_leaf` (degree 0).
- `target_coupling` (sum of imported-symbol counts across edges — how heavily
  coupled, from the resolver's `→ symbols` data).
- `target_graph_dist_from_prev_edit` (hop distance in the dependency graph
  between the current and the previously-edited file; same cluster ≈ 1–2 hops;
  `∞` if disconnected → strong context-switch signal).
- JS/TS only; `NaN` for other languages (auditor-flagged).

**Tier C — co-edit clusters (the "group auth" insight).** Built offline from the
edit trace, independent of the import graph:
- Construct a co-edit graph: edge weight between two files = number of sessions
  in which both were edited within a rolling window. Community-detect (e.g.
  Louvain/label-propagation) → clusters. Persist `ml/data/v7_coedit_clusters.json`.
- Per anchor: `target_cluster_id`, `cluster_switch` (1 if the just-previous edit
  was in a different cluster), `cluster_dwell_steps` (steps since cluster entry),
  `cluster_size`, `cluster_pure_role` (does the cluster agree on a role — a
  "auth group" vs a mixed bag).
- These clusters ARE concrete behavioral regimes — the thing transformer_trade's
  per-regime analysis wanted but never had a clean definition for.

**Tier D — edit-trajectory in graph space (higher; sequence-level).** The
per-step sequence of `(cluster_id, role, is_hub)`; features: cluster-switch
frequency over a rolling window, hub-to-leaf transition rate, dwell-time
distribution. This is where a sequence model is re-tested (it failed for
activity tempo in V6; graph-space trajectory is a different, more structured
signal).

**Leakage:** graph/cluster structure is computed from the **whole-project
topology** (static) and the **past** edit trace only; never from future steps.
The co-edit graph must be built per-fold from training sessions only, then
applied to test (cluster_id assignment is fine; cluster *discovery* must not
see test sessions). The dependency graph is project-static (no leakage).

### 12.4 Integration & phasing (revises §7 order)

The topology family is added as **S8** and **moves to the front of the experimental
queue** because it is cheaper and likely higher-impact than the dynamics re-ports:

| Phase | Deliverable | Gate |
|---|---|---|
| **P-T1** | Tier A only (`target_role`, `target_lang`, impossibility prior) added to `v6_labels`. | **Decisive probe:** `file-errors` or `syntax-check` AUC lifts measurably (>+0.01) vs `v6_labels` with ≤3 new features. If yes → proceed. If no → stop and document. |
| **P-T2** | Real-graph harvester (`v7_topology_graph.py`) + Tier B (degree/centrality/distance). | Stream/coverage auditor passes; merge-integrity passes; ≥1 Tier-B feature passes the Regime-T permutation gate. |
| **P-T3** | Co-edit clusters (Tier C). | ≥1 cluster feature (e.g. `cluster_switch` or `cluster_dwell_steps`) passes the gate. |
| **P-T4** | Tier D trajectory; then combine with S3–S5 dynamics for the full `v7_combined`. | Combined topology+dynamics beats either alone on the §8 headline (step-level AUC ≥ 0.75). |

P-T1 runs **before** S3/S4/S5: if file-role alone lifts AUC substantially (the
expectation, given the 15× label spread and that `target_ext` was dropped), it
validates the thesis and reframes which families matter most.

### 12.5 Topology-specific hygiene (extends §4)

- **Real-data-only graph.** The dependency graph comes solely from
  `resolveImportGraph` cache + warm-up via that same resolver. No Python
  re-implementation of import parsing. A unit test asserts the harvested graph
  matches a sample of cache entries bit-for-bit.
- **Co-edit cluster leakage.** Cluster *discovery* is fit on training sessions
  only; a per-fold split prevents test-session structure leaking into clusters.
- **JS/TS coverage audit.** Report the fraction of edited files that have real
  graph edges; if low, Tier-B signal is weak by construction — flag it before
  drawing conclusions.
- **Cumulative-vs-rate analog does not apply**; topology features are structural.

### 12.6 Artifacts added

| Path | Purpose |
|---|---|
| `ml/features/v7_topology.py` | Tier A/B/C/D feature builder (S8) |
| `ml/features/v7_topology_graph.py` | Harvester for the real `resolveImportGraph` cache + warm-up |
| `ml/data/v7_dep_graph.json` | Assembled real dependency graph (resolver output) |
| `ml/data/v7_coedit_clusters.json` | Co-edit cluster assignment (per-fold) |
| `ml/reports/v7_topology_*` | Per-tier artifacts (auto-discovered by `version_compare.py` as `v7_topologyA`, `v7_topologyB`, …) |

**Version tags:** add `v7_topologyA`, `v7_topologyB`, `v7_topologyC`, `v7_topologyD`
to `version_compare.py` `VERSION_ORDER`.

### 12.7 References (added)

- `src/core/injection-engine.ts:416-541` — `resolveImportGraph` (the reused resolver).
- `src/core/cache.ts:55-64` — `keyToFilename`/`entryPath` (cache harvest path).
- `.pipemd/cache/sources/import-graph:*` — real resolved graph data.
- The §12.1 cross-tab was measured on `ml/data/training_data_v6.parquet`.
