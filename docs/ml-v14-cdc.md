# V14 Roadmap / Cahier des Charges — The Efficiency-Proxy Reward

> **Status:** Specification (drives implementation). Successor to V13.
> **Branch:** `ml`. **Predecessors:** `docs/ml-v13-cdc.md`, the V13 review.
> **Paradigm shift:** replace the content-fit (matching) reward with an
> **efficiency (friction-reduction)** reward, decomposed into channels aligned
> with each injection block, and add the missing **rewrite/churn** information
> inputs.
> **North star:** test whether friction/efficiency is **more learnable (higher
> cross-product R²) and more correlated with the LLM's actual need** than
> content-fit (R²≈0.13–0.20). Move forward without any bug (§5 bar carries).

---

## 1. Why V14 — the ceiling is the target, not the features

V10 proved context causally improves efficiency (−29 s average). V11–V13 then
tried to *predict where* context helps — but with **content-fit** as the reward
("did the block anticipate the agent's actions"). V13 capped at R²≈0.13–0.20.

The diagnosis (reached in the V13 deep review): **content-fit is the wrong
reward.** It rewards the block *matching* the agent's observed trajectory — which
is closest to *redundant*. The LLM's highest need is where context **changes**
the trajectory by **reducing friction** (rework, search, mistakes). Content-fit is
**anti-correlated with the highest-value injections**: a block that surfaces an
unknown-needed file (preventing a rework cycle) scores LOW under content-fit
because the agent never touched that file. R² was never going to clear ~0.20 on a
target that measures the wrong thing.

**V14 measures the right thing:** context improves efficiency **by reducing
friction** — so friction (especially the channels content-fit was blind to:
**compile errors, test failures, and rewrite/rework**) is both the right *reward*
and, via rewrite history + git churn, the right *input*. This is the mechanism
V10's speed-outcome gestured at but never decomposed.

---

## 2. Objective

**Primary:** define and validate a **decomposed efficiency reward** where each
injection block is measured in its **native friction currency** (syntax-check →
compile friction; file-errors → lint; test-failures → test; etc.), and test
whether **friction-level is more learnable cross-product than content-fit**
(R² > V13's 0.13/0.21).

**Secondary:** add the missing **rewrite/churn** information inputs (in-session
rewrite + git churn percentile + friction-history) and measure their incremental
ΔR².

**Honesty ceiling (inherited, non-negotiable):** efficiency-reduction is causal;
friction-**level** is the observational learnable target. High friction can mean
*hard file* (context won't help) or *missing context* (context will help) — so
the **reward must be friction-reduction** (matched controls), not friction-level.
Every result `observational_unvalidated`; the bench A/B remains the only causal
arbiter. No deployment claim.

---

## 3. The efficiency formula (the core spec)

**Friction channels** in window `W` after anchor `a` — each a count of steps
exhibiting that friction:

| Term | Channel | Trace signal | Block currency |
|---|---|---|---|
| `S` | search | **excess** reads (read/glob/grep not followed by a write within a short sub-window) | general context |
| `C` | compile/type | output matches `TYPE_RE` (tsc / type errors) | **`syntax-check`** |
| `L` | lint | output matches `LINT_RE` (eslint/ruff) | **`file-errors`** |
| `T` | test | output matches `TEST_RE` (test failures) | **`test-failures`** |
| `X` | runtime | runtime exceptions / `Traceback` (new small detector) | runtime context |
| `W` | rework | rewrite steps (edits to a file already edited in `W`) + reverted edits | convergence |
| `F` | tool-failure | `state_status == failed` | (low-stakes) |

**Productive output:**
- `P` = **convergent writes** = first-time edits to a file **not** rewritten/
  reverted within `W` (the write "stuck"). *Primary definition: window-bounded;
  validation: session-end survival.*
- `M` = **milestones** = test-suite-pass events, files-completed.

**Efficiency:**
```
Efficiency(a) = (P + M) / (P + M + S + C + L + T + X + W + F + ε)   ∈ (0,1)
```
—the fraction of window effort that produced **lasting progress** vs friction.

**Per-block reward (each block in its native currency), via matched controls:**
```
Reward(syntax-check)         → ΔC
Reward(file-errors)          → ΔL
Reward(test-failures)        → ΔT
Reward(import-graph/file-content) → ΔW + ΔS
where Δchannel = channel(with block, matched anchor) − channel(without block)
```
This finally counts **prevention** (a block that stops a type error registers
`ΔC > 0`) — the highest-value case content-fit could not see.

**Channel weights:** start **unweighted** (each step = 1). Learn per-channel
weights as a later refinement (V15) once the unweighted signal is established.

---

## 4. Scope

**In scope**
- Friction-channel extraction (the decomposed formula; reuse V7/V9 detectors +
  step-counting; new `X` runtime detector).
- Efficiency reward: friction-**level** as the learnable target; friction-
  **reduction** as the causal reward (matched controls).
- Rewrite/churn inputs (in-session rewrite + git churn percentile + friction-
  history features).
- Head-to-head vs content-fit (does friction beat R²≈0.15?).

**Out of scope (deferred)** — bench A/B (V15); online/serving; per-channel weight
learning; new blocks/resolvers.

---

## 5. Hygiene & "no bugs" bar (carried; V14-specific below)

All prior rules apply: bench-free, coverage auditor hard gate, merge-integrity,
same-regime/same-split reporting, module-import pytest, honest negatives,
**R-1 no causal claim without bench**, **R-9 aggregate monotonicity**, **R-10
+0.005 threshold**, **R-12 baseline-first**, **R-13 alignment-audit**. **V14-binding:**

- **R-14 Friction-reduction ≠ friction-level.** The *learnable target* is
  friction-level (observational); any *causal/value* claim requires the
  friction-**reduction** reward (matched controls) AND ultimately the bench.
  Never headline a friction-level number as "context helps."
- **R-15 Channel-leakage guard.** Friction channels in `W` after `a` are the
  **outcome** (future, legitimate); friction-**history** before `a` is a
  **feature** (past). Same channel can be both — enforce the temporal split; a
  pytest verifies no future leakage into features.
- **R-16 Detector parity.** `C/L/T` reuse `v7_labels.py` TYPE_RE/LINT_RE/TEST_RE
  verbatim (no redefinition — consistency with V7/V9). The new `X` (runtime)
  detector is unit-tested against samples.
- **R-17 Convergence-window soundness.** `P` (convergent writes) and `W` (rework)
  are computed over the same `W` — a pytest verifies a rewrite is counted in `W`
  and excluded from `P` (no double-counting).

---

## 6. Specifications

### S1 — Friction-channel extraction (`ml/reward/v14_friction.py`)
- For each V11 simulated anchor, compute `S, C, L, T, X, W, F, P, M` over the
  forward window `W` (same horizon as V11). Reuse TYPE_RE/LINT_RE/TEST_RE from
  `v7_labels.py` for `C/L/T`; add a small `RUNTIME_RE` for `X`.
- `S` = excess reads (reads with no write within a `k_search` sub-window, default
  3 steps). `W` = rewrites (edits to a file already edited in `W`) + reverts.
  `P` = first-time edits not rewritten/reverted in `W`. `F` = failed tool steps.
  `M` = test-pass / file-complete events.
- Output `ml/data/v14_friction.parquet`: per-anchor channel counts + the
  efficiency ratio + per-channel deltas (for the matched-control reward).
- **Gate:** every channel measurable on ≥80% of anchors; non-degenerate (std>0);
  detector-parity tests (R-16); convergence double-count test (R-17); bench-free.

### S2 — Efficiency reward + friction-level target (`ml/reward/v14_reward.py`)
- **Learnable target (primary):** predict friction-level per channel (and the
  composite efficiency) from context features, leave-one-directory-out (same
  split as V11–V13). Report cross-product R².
- **Causal reward (secondary):** per-block `Δchannel` via V10's matched-control
  IPTW (propensity on context features), bootstrap CIs, de-confounding
  diagnostics (R-3). Labeled `observational_unvalidated` (R-14).
- **Gate (the headline test):** friction-level cross-product R² vs content-fit's
  0.13/0.21 — does the target change move R²?

### S3 — Rewrite/churn inputs (`ml/reward/v14_inputs.py`)
- **In-session rewrite (micro):** target_file rewrite-count-so-far, session
  rewrite-rate, recent rewrite burst, read/write/error/rewrite ratios — past-only
  features (R-15).
- **Git churn (macro, cross-project-stable):** per-file churn (commits, lines
  changed) from git history **before** the session; **percentile rank within
  project** (raw counts don't generalize — rank does, like topology); recent
  churn velocity. Computed at the git HEAD the V11 simulator already resolves.
- **Friction-history features:** the file's past `S/C/L/T/W` rate (the agent's
  friction history with this file).
- **Gate:** ΔR² ≥ +0.005 cross-product under aggregate monotonicity (R-9/R-10);
  leakage pytests (R-15).

### S4 — Per-block reward alignment + ablation vs content-fit
- Compute the per-block `Δchannel` rewards (S2) and report each block's estimated
  efficiency contribution in its native currency.
- **Ablation:** on the SAME cross-product split, compare friction-target R² vs
  content-fit R² (V13's 0.13/0.21). Document which channels carry the signal.
- **Gate:** the ablation is reported with per-channel attribution; the
  friction-vs-content-fit verdict is the V14 headline.

---

## 7. Phased plan & gates

| Phase | Deliverable | Gate |
|---|---|---|
| **V14-0** | Friction-channel extraction (S1) — the decomposed formula. | All channels measurable/non-degenerate; detector parity (R-16); no double-count (R-17); bench-free. |
| **V14-1** | Reproduce V13 baseline (R-12) + friction-level target + ablation vs content-fit (S2/S4). | **Headline: friction-level R² vs content-fit 0.13/0.21.** If friction wins → paradigm validated. |
| **V14-2** | Rewrite/churn inputs (S3); incremental ΔR². | ΔR² ≥ +0.005 cross-product (R-9/R-10); leakage tests pass. |
| **V14-3** | Per-block `Δchannel` causal rewards (matched controls, S2 secondary). | Diagnostics (R-3); per-block rewards with bootstrap CIs; `observational_unvalidated`. |
| **V14-4** | Final scoreboard + verdict (efficiency paradigm vs content-fit). | Headline R² + per-block currency rewards reported; bench A/B named as next step. |

Each phase = one commit (`feat(ml): V14 …`). Honest negatives are valid: if
friction-level is **not** more learnable than content-fit, that itself is a
profound finding (relevance is inherently unpredictable from traces, regardless
of the target) — document it; do not force R².

---

## 8. Acceptance criteria — Definition of Done

- The decomposed efficiency formula (§3) is implemented and **every channel is
  measurable/non-degenerate**; detector parity with V7/V9 (R-16).
- **Friction-level cross-product R² is reported vs content-fit's 0.13/0.21** —
  the single headline — up (target was the ceiling) or flat (relevance ceiling is
  fundamental).
- Rewrite/churn inputs tested for incremental ΔR² under aggregate monotonicity.
- Per-block `Δchannel` rewards reported in native currency, with matched-control
  diagnostics, labeled `observational_unvalidated`.
- The reducible-vs-irreducible-friction caveat (R-14) is explicit: friction-level
  is the target, friction-**reduction** is the reward, the bench is the arbiter.
- All hygiene gates pass; every new module has import + leakage + detector-parity
  pytests.

**Honest-negative outcomes are valid:** if friction doesn't beat content-fit, or
rewrite/churn don't add ΔR², document why. The point of V14 is to finally test the
right target; if the right target also ceilings, that is the answer.

---

## 9. Risks (and the guardrail)

| Risk | Guardrail |
|---|---|
| Friction-level conflates "hard file" with "needs context" | R-14: reward = friction-**reduction** (matched controls); level is the target only. |
| Tautology: churn predicts friction trivially | Reward is reduction, not level; churn feature is past-only (R-15). |
| Channel leakage (future friction into features) | R-15 temporal-split pytest. |
| `S` (search) overcounts friction (reads are necessary) | Excess-reads definition (reads with no nearby write), not raw count. |
| `P`/`W` double-count a rewrite | R-17 convergence-window pytest. |
| Confusing "predicts friction" with "causally reduces it" | R-1 + R-14: `observational_unvalidated`; bench deferred. |
| Noise-chasing marginal ΔR² | R-10 threshold; report per-fold variance. |

---

## 10. Artifacts

| Path | Purpose |
|---|---|
| `docs/ml-v14-cdc.md` (this file) | V14 specification |
| `ml/reward/v14_friction.py` | Friction-channel extraction + efficiency formula (S1) |
| `ml/reward/v14_reward.py` | Friction-level target + per-block Δchannel rewards (S2) |
| `ml/reward/v14_inputs.py` | Rewrite (in-session) + git churn + friction-history inputs (S3) |
| `ml/data/v14_friction.parquet` | Per-anchor channel counts + efficiency + deltas |
| `ml/reports/v14_ablation.md` | Friction-target R² vs content-fit (the headline) |
| `ml/reports/v14_perblock_rewards.json` | Per-block Δchannel rewards + diagnostics |
| `ml/tests/test_v14_*.py` | detector-parity, leakage, convergence, baseline-parity |

**Version tags** (auto-discovered): `v14_friction`, `v14_inputs`, `v14_reward`,
`v14_model`.

---

## 11. References

- `docs/ml-v13-cdc.md`, the V13 review — the content-fit ceiling + the matching-vs-changing insight.
- `ml/features/v7_labels.py` — TYPE_RE/LINT_RE/TEST_RE (reused for `C/L/T`, R-16).
- `ml/reward/v10_reward.py` — matched-control IPTW machinery (reused for Δchannel).
- `ml/sim/v11_simulator.py` — the anchor universe + git-HEAD resolution (for churn).
- `ml/reports/v10_postmortem.md`, `docs/ml-lessons-for-main.md` — relevance-vs-value, no-bugs bar.
