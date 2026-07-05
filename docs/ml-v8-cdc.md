# V8 Roadmap / Cahier des Charges — Code-Content Feature Family

> **Status:** Specification (drives implementation). Successor to V7.
> **Branch:** `ml`. **Predecessors:** `docs/ml-v7-cdc.md`, `ml/reports/v7_combined_summary.json`.
> **Mandate from the owner:** *light polish of V7, then move forward — without any bug.*
>   The "no bugs" bar (§4) is the spine of this document; every prior bug class
>   has an explicit guardrail here.

---

## 1. Where V7 actually landed (honest baseline — read from the artifacts)

V7 is **not** the unambiguous win its handback claimed. The verified state:

- **One real win:** `file-errors` (lint) step-level onset **AUC 0.761** (≥0.75 gate), healthy 27.4% positive rate. File topology (role/lang/coupling) is the dominant predictor — the §12 thesis was validated.
- **Two near-random blocks:** `syntax-check` (type) onset **AUC 0.515**, `test-failures` **0.577** (only 187 positives — unreliable).
- **Combined model degraded:** `v7_combined` (138 feat, Mean AUC 0.734) is *worse* than topology-only (43 feat, 0.863). Dynamics features that individually passed permutation collectively added noise.
- **Ranker is below inject-all in absolute value:** under V7's own step-level labels, ranker = 180.1 useful/dec vs inject-all baseline = 200.0. It wins on **token efficiency** (+26% useful/tok) and noise (0.422 vs 0.541), not on absolute useful tokens.
- **The headline overclaimed in three ways:** (a) the "+12.3% useful" compared *cross-regime* (session vs step labels — invalid); (b) "100% prevention" was a *retrospective, circular* metric (prediction recall, not causal prevention); (c) the CDC P4 **prospective bench was never run**.
- **Honest negatives, correctly handled:** OU reverted with sound justification (reasoning 95% sparse; topology dominates); Chebyshev rolling-rate and NegBinom 2-param fixes worked.

**The gap V8 attacks:** `syntax-check` (type-error onset) is near-random because type errors are **content-dependent** — you cannot predict them from file role, graph position, or activity tempo. You must *see* the code (`as any`, `@ts-ignore`, missing return types, `Promise` without `await`). V7 had no content features. **V8 adds them.**

---

## 2. V8 thesis (reformulated)

Introduce a **code-content feature family** — detecting keywords, keyword combinations, and code patterns in the bytes the agent actually **reads and edits**. This is the *semantic* layer complementing V6 (metadata), V7-topology (structure), and V7-dynamics (tempo).

V1–V3 tried keywords on **reasoning text** (`rk_*` flags, `build_features.py:110`) and title/reasoning TF-IDF — judged useless in V5b (reasoning is 95% sparse/optional; reasoning TF-IDF contributed 0.008 AUC). V8 applies detection to the **code itself** (always present, dense), with the modern hygiene ensuring an honest test. **The headline hypothesis: code-content features lift `syntax-check` (type) onset off 0.515**, because they expose the type debt that topology/tempo cannot see.

---

## 3. Decisions locked (owner)

1. **Dedicated code-content pull** (not a global ETL re-extract with larger truncation). Keeps the main `steps.jsonl` lean; pulls only read/edit regions.
2. **(a) curated flags + (b) combinations + (d) code-smell regexes FIRST.** (c) Code TF-IDF is a **research track** — built and tested, kept only if it beats (a)+(b)+(d).
3. **Light V7 polish** (V8-0) — trim + diagnose + honest reporting; do NOT over-invest in fixing type-error onset before content features (the content family is the likely fix).
4. **Move forward without any bug** — §4 is binding.

---

## 4. The "no bugs" bar (binding — each rule is a prior bug class)

| # | Prior bug class | Binding guardrail in V8 |
|---|---|---|
| 1 | Module-import errors at runtime (OU `re` import) | **Every** new module imports cleanly when imported (not just under `__main__`). A pytest imports every `ml/features/v8_*.py` and `ml/etl/v8_*.py` module. |
| 2 | Namespace mismatch (merge step_idx) | Every external builder passes `coverage_auditor.check_merge_integrity` before eval. (V7 confirmed the V5 namespace is the tool/patch index — preserve it.) |
| 3 | Degenerate 1-DOF features (FP Geometric) | The **N-DOF detector** gates every emitted group; effective rank < ⌈size/4⌉ fails. |
| 4 | Degenerate fits on cumulative sums (Chebyshev r2≈0.9) | The **cumulative-vs-rate guard** gates every curve input. |
| 5 | Cross-regime metric claims ("+12.3% useful") | **Every** scoreboard delta compares **same-label-regime** numbers only. `version_compare.py` is extended to refuse/tag cross-regime rows. No cross-regime headline is permitted. |
| 6 | Retrospective dressed as prospective ("100% prevention") | Any "prevents / value" claim requires the **prospective bench** (real agent runs). Retrospective metrics are labeled `retrospective_only` and never called "prevention." |
| 7 | Features that pass individual permutation but degrade the aggregate (V7 138-feat < 43-feat) | **Aggregate monotonicity gate:** a family is kept only if the *combined* model improves on the headline metric (Mean AUC + the §6 value metric) vs the previous combined model. Individual permutation passing is necessary but NOT sufficient. |
| 8 | Stream unsuitability (sparse error_rate fed to OU) | Stream-suitability check gates every stochastic-process input. |
| 9 | Bench contamination | Dedicated pull reuses `is_bench_session`; a test asserts 0 bench sessions in the code-content output. |
| 10 | Coverage auditor skipped | Coverage auditor is a **hard pre-training gate** for every dataset, including the §5 N-DOF / cumulative guards. |

A phase that violates any rule is **not done** — fix it before proceeding.

---

## 5. The honest value metric (replaces V7's flawed headline)

Because the ranker trades coverage for noise reduction, a single "useful tokens" number is misleading. V8 reports **same-regime, three numbers** as the headline, plus a baseline delta:

- `useful_per_token` = useful_tokens / tokens_injected (efficiency).
- `noise_rate` (lower is better).
- `coverage` of error-onset events.
- vs the inject-all baseline **under the same labels**.

The headline claim is permitted only as: *"at operating point X, V8 delivers [efficiency/noise/coverage] vs inject-all [baseline], same labels."* No cross-regime comparisons. No "prevention" without the prospective bench.

---

## 6. Specifications

### S1 — V8-0: light polish of V7
- **`v7_polished`:** trim `v7_combined` to genuine survivors by the **aggregate monotonicity gate** (rule 7) — topology A + select Chebyshev (`edit_rate_c1`, `reasoning_r2`) + NegBinom bins; drop dynamics noise. Require `v7_polished` Mean AUC ≥ `v7_combined` AND ≥ `v7_topologyA` on the same regime.
- **Diagnose** `syntax-check` 0.515: is the type-onset label well-formed? Are type errors surfacing in tool outputs via the right detector? Write a 1-page diagnosis to `ml/reports/v8_syntaxcheck_diagnosis.md`. **Diagnose only** — the fix is S3.
- **`test-failures` sparsity:** 187 positives is too few; widen K or document a merge. Decide and record.
- **Honest reporting:** correct V7's cross-regime scoreboard framing (rule 5).

### S2 — V8-1: dedicated code-content pull (`ml/etl/v8_extract_code_content.py`)
- Read `opencode.db` once; for parts where `type=='tool'` and `tool in {read, edit, write, patch}`, extract the code content:
  - **read:** `state.output` (full file content, capped at **8 KB** — the header/imports region is most keyword-dense).
  - **edit/patch:** `state.input.{oldString,newString}` (the exact edited region, capped 8 KB each).
  - **write:** `state.input.content` (capped 8 KB).
- **Bench-free (rule 9):** join `part → session.directory`; exclude via `is_bench_session`. Assert 0 bench in output.
- **Output:** `ml/data/v8_code_content.jsonl` — `{session_id, step_idx (tool/patch index, same namespace as training), part_id, tool, file_path, ext, ecosystem, chunks: [{kind: read|old|new|content, text}]}`.
- **No truncation bugs (rule 1, 10):** pytest verifies field lengths ≤ cap and that the pull is idempotent. Coverage report: % of trace steps with content, by ecosystem.
- The DB retains full content (verified: a read output is 1310 chars in DB vs 500 in jsonl) — the cap is the only limit.

### S3 — V8-2: keyword families (a)+(b)+(d) — `ml/features/v8_code_keywords.py`
Consume `v8_code_content.jsonl`; emit, per anchor step, features over the edited region and the most-recent read window:

- **(a) Curated keyword flags** per ecosystem (TS/JS, Python, Go, Lua). Counts/booleans:
  - TS/JS: `async, await, Promise, .then, .catch, import, from, export, interface, type, any, unknown, as, try, catch, throw, new, class, extends, implements, readonly`.
  - Python: `def, class, import, async, await, try, except, raise, lambda, yield, with, ->, :` (type hints).
  - Go: `func, interface, struct, go, chan, select, defer`.
  - Lua: `function, local, require`.
- **(b) Keyword combinations** (the owner's "combinaison") — boolean co-occurrence within the region:
  - `combo_async_no_await` (async present, await absent → promise drift).
  - `combo_promise_no_catch`, `combo_import_type` (type-only imports), `combo_any_cast`, `combo_try_no_catch`.
- **(d) Code-smell regexes** — counts of `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `as any`, `as unknown`, `eslint-disable`, `TODO`, `FIXME`, `HACK`, `eval(`, `Function(`, `innerHTML`. → "debt density."
- **Leakage:** features computed only from steps `≤ t`; the read window is past-only.
- **Gates:** auditor (incl. N-DOF, cumulative-vs-rate does not apply to flags) + **aggregate monotonicity** (rule 7) + permutation. **Headline test:** does it lift `syntax-check` off 0.515?

### S4 — V8-3: code TF-IDF research track (c) — `ml/features/v8_code_tfidf.py`
- Tokenize edited regions (code-aware split: identifiers, operators, punctuation); fit TF-IDF **on train sessions only**, capped dims (≤200), persisted vocab.
- **N-DOF guard** (rule 3) and permutation gate. Kept **only if** it beats (a)+(b)+(d) on the aggregate monotonicity gate — otherwise reverted-with-postmortem (this is the reasoned re-test of the V1–V3 idea that failed on reasoning text; document whether code-TFIDF differs).

### S5 — V8-4: combine + the prospective bench V7 skipped
- `v8_combined` = `v7_polished` + surviving keyword families, admitted only via rule 7.
- **Prospective bench (rule 6):** run a benchmark scenario with proactive injection vs reactive, multiple runs per cell, compared at equal quality grade (`bench/rubric.md`). Report actual error reduction. No retrospective metric is called "prevention."
- `ml/eval/v8_prospective_eval.py` orchestrates the cell; reuses `proactive_eval.py` for the decision rule but runs the agent.

---

## 7. Phased plan & gates

| Phase | Deliverable | Gate (binding — §4 rules apply) |
|---|---|---|
| **V8-0** | `v7_polished` + syntax-check diagnosis + honest reporting. | Aggregate monotonicity (rule 7): `v7_polished` ≥ `v7_combined` AND ≥ `v7_topologyA`, same regime. Diagnosis written. |
| **V8-1** | Dedicated code-content pull. | Module-import test (rule 1) + bench-free assertion (rule 9) + idempotent; coverage report. |
| **V8-2** | Keyword families (a)+(b)+(d). | Auditor + permutation + **aggregate monotonicity**; headline: `syntax-check` AUC lifted measurably off 0.515. |
| **V8-3** | Code TF-IDF (c, research). | N-DOF + permutation + aggregate monotonicity; kept only if it beats V8-2. |
| **V8-4** | `v8_combined` + prospective bench. | Prospective bench shows real error reduction at equal quality; same-regime value metric (§5) reported honestly. |

Each phase = one commit (`feat(ml): V8 …`). A gate failure → fix (rule-bound, §4) before proceeding; an unrecoverable negative → revert-with-postmortem citing same-regime numbers.

---

## 8. Acceptance criteria — Definition of Done

- `v7_polished` strictly improves the same-regime aggregate over `v7_combined` (no noise retained).
- Code-content pull is bench-free, idempotent, capped, and import-clean.
- At least one of (a)/(b)/(d) lifts `syntax-check` onset AUC measurably (the thesis test) — or an honest negative is documented explaining why content features don't fix type-onset.
- The scoreboard reports **same-regime** deltas only; no cross-regime headline remains.
- A **prospective** bench (real agent runs) validates any proactive-value claim; retrospective metrics are labeled as such.
- `coverage_auditor.py` (with N-DOF + cumulative guards) passes on every dataset before training; `merge-integrity` passes on every builder.
- `pnpm tsc --noEmit` + `pnpm eslint src/` unaffected (research lane); pytest covers every new module (rule 1).

If the thesis fails (content features don't lift type-onset), that is a legitimate, well-documented negative — do not force the model, and do not activate serving.

---

## 9. Risks (and the rule that catches each)

| Risk | Catch |
|---|---|
| Edited region too small to be informative | Coverage report in V8-1; fall back to read-window features. |
| TF-IDF repeats the reasoning-TFIDF waste | N-DOF guard + aggregate monotonicity (rules 3, 7). |
| Cross-regime overclaim recurs | Rule 5 + version_compare enforcement. |
| "Prevention" overclaim recurs | Rule 6 — prospective bench required. |
| Features pass individually, degrade aggregate | Rule 7 — aggregate monotonicity gate. |
| Pull imports bench code | Rule 9 — `is_bench_session` + test. |
| Runtime import error | Rule 1 — import pytest. |
| Multi-ecosystem keyword noise (flag explosion) | Permutation + aggregate monotonicity prune per ecosystem. |

---

## 10. Artifacts

| Path | Purpose |
|---|---|
| `docs/ml-v8-cdc.md` (this file) | V8 specification |
| `ml/etl/v8_extract_code_content.py` | Dedicated code-content pull (S2) |
| `ml/data/v8_code_content.jsonl` | Code content (bench-free, capped 8 KB) |
| `ml/features/v8_code_keywords.py` | (a)+(b)+(d) families (S3) |
| `ml/features/v8_code_tfidf.py` | (c) research track (S4) |
| `ml/eval/v8_prospective_eval.py` | Prospective bench orchestrator (S5) |
| `ml/eval/version_compare.py` | Extended: same-regime enforcement + v8 tags |
| `ml/reports/v8_*` | Per-phase artifacts |
| `ml/tests/test_v8_*.py` | Import + leakage + bench-free + idempotence tests |

**Version tags** (auto-discovered): `v7_polished`, `v8_keywords`, `v8_tfidf`, `v8_combined`, `v8_proactive`.

---

## 11. References

- `docs/ml-v7-cdc.md` — predecessor; §12 topology family.
- `ml/reports/v7_combined_summary.json` — V7 verified baseline (§1).
- `ml/features/build_features.py:110` — the V1–V3 `rk_*` reasoning-keyword attempt (the history V8 redeems on code).
- `ml/etl/extract_opencode_db.py:37-39` — the ETL truncation (500/1000) V8 bypasses with a dedicated pull.
- `src/core/cache.ts:55-64` — cache path conventions (for consistency).
- `bench/rubric.md` — equal-quality-grade discipline for the prospective cell.
