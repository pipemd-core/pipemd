# Lessons from the ML Experiment — Guidance for the PipeMD Main Branch

> **Purpose.** The `ml` research branch ran **fifteen versions (V1–V15)**
> investigating ML-driven context injection. This document extrapolates the
> hard-won lessons into **actionable guidance for the `main` (product) branch**
> — both **how the core injection feature set should improve** (§1, the
> positive agenda) and the **hygiene/discipline** that gates any data-driven
> work (§3–§4).
> **Evidence source:** `ml/reports/v15_postmortem.md` (the capstone),
> `ml/reports/v10_postmortem.md`, and the V1–V15 reports/CDCs. Numbers from
> V1–V14 are `observational_unvalidated` (V10 R-1); V15 is the first
> **prospective** A/B (V15 R-21). Product decisions carry the n=5 / n=3
> caveats forward.

---

## 0. The headline findings

### 0.1 V10 — the average effect (observational)

Injection has a real **average causal benefit** (~−29 s step duration, IPTW 95%
CI excludes 0, propensity AUC 0.514 — minimal confounding) — *on a small
sample (5 sessions / 2 projects).* The per-context benefit is **not learnable**
from trace features in that sample (reward-model R² = −1.09, worse than
constant). The **observational-best policy is "always inject within budget."**

### 0.2 V11–V14 — the observational ceiling

Four versions pushed the observational learnability ceiling from two
directions — **content-fit** (V11–V13: "did the block anticipate the agent's
actions") and **friction/efficiency** (V14: "did the block reduce rework") —
and hit a consistent cap:

- **Content-fit R² ≈ 0.13–0.21** (V11 Ridge 0.13 / LGB 0.16; V13 LGB 0.2086).
  Topology is the **only** feature family that generalizes cross-product
  (+0.005 Ridge / +0.024 LGB; V12 rehabilitated it). All richer families
  (TF-IDF, keywords, OU, Chebyshev, Fokker-Planck) **hurt** cross-product —
  the signature of a generalization ceiling.
- **Efficiency/friction is not learnable as a composite** (V14). But V14 found
  **one new durable signal**: rewrite-rate (+0.0123 on content-fit Ridge; the
  rework target hit LightGBM R²=0.2905) — the first new generalizing family
  since topology.
- **V14's decisive negative:** `ml/reports/v14_perblock_rewards.json` shows
  `n_common_support: 0` for **every** block. Block applicability is
  **deterministic given context** (import-graph fires for *all* JS/TS anchors;
  there is no comparable JS/TS anchor where it *didn't* fire to serve as a
  control). **No observational dataset can estimate the per-block causal
  effect** — not a sample-size problem, a structural one. The bench is the
  **only** counterfactual.

### 0.3 V15 — the prospective confirmation (the capstone)

V15 built the first real ML-informed injection policy (`delivery: "adaptive"`
= topology filter + rewrite-aware BOOST) and ran the **first prospective A/B**
(3 arms × 3 runs, scenario 05-json-dates, glm-5.1):

1. **Adaptive does NOT beat always-inject at equal quality.** Adaptive
   **increased** rework (median 1 vs 0) and wall time (2.1× slower). The
   rewrite-aware BOOST backfired — forced re-injection of unchanged context
   caused the agent to loop.
2. **The topology filter alone saved 30% of input tokens at equal quality**
   (532 vs 762). This is the **under-hyped, shippable win** — deterministic,
   zero ML, no caveat on the token dimension.
3. **"Always inject" is now prospectively confirmed** as the best-supported
   policy on one task (V10 said it observationally; V15 confirms it causally).

### 0.4 Three product conclusions (all carrying the n=5 / n=3 caveats)

1. **The core premise is validated** — context injection genuinely helps on
   average. The product is sound; the question is *how to improve it*, not
   whether to build it.
2. **The value lives in the *content* layer** (what gets injected: resolvers,
   freshness, signal density), **not the *selection* layer** (ML picking which
   block). The smartest selection lost to always-inject; the strongest
   per-block reward was `file-content` (the file's own state). **Invest in
   resolvers and block content, not in ML selection.**
3. **The topology filter is a free, deterministic token win** that ships
   regardless of the ML verdict. It is the only ML-derived code that belongs
   on `main` — and it contains no ML.

---

## 1. Core feature set — how PipeMD's injection should improve

This is the positive product agenda, grounded in what the data showed about
which context actually helps.

### 1.1 The product premise is validated — improve, don't replace
V10 is the first version that measured a *real* outcome, and injection moved it
(−29 s, CI excludes 0, low confounding). V15 confirmed the policy direction
prospectively. **The core feature set earns its place**: context injection
makes the agent faster on average. Treat the `ml` findings as a guide to
*where the value concentrates*, not as a verdict against injection.

### 1.2 Invest in the high-value blocks; reconsider the weak ones
V10's per-block causal rewards (observational, small-n, but directional):

| Block | IPTW Δ [95% CI] | Verdict | Action |
|---|---|---|---|
| **file-content** | **−58.8 s** [−78.6, −38.8] | **Strongest** | **Invest** — the file's own content/state is the most valuable injection |
| **file-errors** | −29.3 s [−55.2, −7.1] | Significant | **Invest** — error context pays off |
| **import-graph** | −23.6 s [−45.0, −0.0] | Borderline | Keep, but it's not the top earner |
| **crew-todos** | −18.4 s [−67.4, +39.9] | Not sig | **Reconsider** — audit whether it earns default-on |
| **git-context** | −12.4 s [−33.6, +6.4] | Not sig | **Reconsider** — weak; maybe conditional, not always |

**Implication:** the product's improvement budget should flow to the resolvers
behind `file-content` and `file-errors` — freshness, accuracy, signal density —
because those carry the most measured value. Weak blocks should justify their
default-on status or become conditional.

### 1.3 The content layer > the selection layer (strategic — hardened by V15)
`file-content` (literally showing the file's recent state) produced the strongest
reward; the ML *selection* layer never beat always-inject — **including the V15
prospective test of the natural policy built from the two most durable signals.**
**The block content is the product; selection is secondary.** Prioritize:
- **Resolver quality** — richer, more current, better-formatted block output.
- **Signal density** — every line of an injected block should carry information
  (the V8 finding that code *content* carries the only weak type-error signal
  reinforces this: content is where signal lives).
- **Freshness** — `steps_since_lint/tsc` were top features in V5/V7; stale
  context is noise. Wire freshness into the resolver loop (re-resolve on change,
  not on a fixed TTL alone).

### 1.4 File-aware injection — the durable deterministic signal (V7, shipped via V15)
V7's topology finding is the single most actionable result: file **role/lang**
drives a **15× spread** in error likelihood (`.mjs` 0.67 vs `.json` 0.045). This
is a cheap, zero-ML, highly reliable signal. V15 hardened it into a deterministic
file-type gate (`src/core/topology-filter.ts`) and proved it saves 30% of input
tokens at equal quality. **This ships to `main` as part of the active-mode
baseline** (ROADMAP Phase 2A.1):
- **Match the block to the file's type/role:** inject `syntax-check` only for
  typeable files (`.ts/.tsx/.js/.go`), `file-errors`(lint) only for lintable
  files, `import-graph` for source hubs, test context for test files.
- **Suppress impossible injections** (no type context for `.css/.html/.md`) —
  this alone removes a large chunk of noise.
- The file's role/lang is already known at injection time (`target_ext`, path) —
  this is configuration, not ML.

This captures the dominant signal in the data with **zero model risk** and is the
highest-leverage near-term improvement.

### 1.5 Adaptive block rendering — unlock the "cheap middle" (untested deterministically)
Today every block renders at a fixed `max-lines` and the decision is binary
(inject full / don't). V7/V8 showed that binary plateaus; V10 showed smart
selection doesn't help; **V15 showed one policy shape (quantity-boost) actively
backfires**. But the **decision space** itself is undertapped: blocks could
render at **precision tiers**:

- **T0 off / T1 signal (one-liner: "hub: 15 importers", "3 errors") / T2 summary
  (top-3) / T3 full (today).**
- Driven **deterministically** by role + engagement (a hub `.ts` file the agent
  is actively editing → T3; a leaf it glanced at → T1; a `.css` → T0).

This is a **new core capability** — adaptive, role-aware rendering — that needs
no ML. It directly attacks the noise problem (cheap T1 for uncertain cases
instead of all-or-nothing). **Discipline gate:** ship as opt-in
(`delivery: "tiered"`), bench prospectively (ROADMAP §2B.4) before defaulting.

### 1.6 Leverage the dependency graph beyond the `import-graph` block
`resolveImportGraph` (`src/core/injection-engine.ts:416`) and the harvested
`ml/data/v7_dep_graph.json` are real assets. Use the graph for richer, smarter
context that the current blocks don't expose:
- **"Editing a hub → show dependents at risk"** — cross-file impact, not just
  importers.
- **Neighborhood-aware error context** — when `file-errors` fires for a file,
  surface whether its dependents are likely affected (the V9 neighborhood
  concept, used productively).
- The graph is project-static (no leakage risk) and already built — this is
  incremental product value on existing infrastructure.

### 1.7 Token budget as a first-class product lever
The one proven value of the ranker was **noise reduction / token efficiency**
(not absolute value). Make that a deterministic, first-class feature:
- Expose the per-session token budget as a tunable product knob.
- Implement budget-constrained always-inject as the documented default policy.
- Let precision tiers (§1.5) compose within the budget — that's where
  deterministic curation can finally beat naive inject-all on *efficiency*.

### 1.8 What the data says does NOT work (so don't build it)
- **ML-based per-block selection** (V10: worse than always-inject observationally;
  V15: worse prospectively for the boost shape).
- **The rewrite-aware BOOST policy** — force re-injection when `editCount ≥ 2`
  (V15: caused agent loops, rework UP, wall time 2.1×. Dedup is behavior-shaping;
  do not bypass it without a measured reason).
- **Predicting file-level error onset** from session features (V9: random).
- **Per-file "will this error" prediction** to drive injection (V5/V9: no signal).
- **Reasoning-text keywords** as a signal (V1–V3/V5b: useless; reasoning is 95%
  sparse).
- **Content-fit / friction-composite reward models** as policy drivers (V11–V14:
  ceiling R²≈0.13–0.29; zero common support for per-block reward).

Save the engineering effort these would consume.

---

## 2. Product-decision lessons — what to ship on `main`

| # | Lesson (evidence) | Action |
|---|---|---|
| **P1** | The ML ranker (`delivery: "learned"`) was worse than always-inject observationally (V10) AND prospectively (V15 boost). | Default `delivery: "active"`; keep `"learned"` as a documented experimental stub with active-fallback on main. The suppress shape gets one prospective test on `experimental`. |
| **P2** | File topology is the one durable signal (V7 §12; V12 rehabilitated; V15 shipped). | **Ship the topology filter in the active-mode baseline** (ROADMAP Phase 2A.1). Zero ML, 30% token saving. |
| **P3** | Binary inject-or-not plateaus (V7, V8); one policy shape (boost) backfires (V15); tiers are untested deterministically. | Ship adaptive precision tiers as an opt-in deterministic policy (§1.5), benched prospectively. |
| **P4** | "Always inject within budget" is the evidence-supported default (V10 observational; V15 prospective). | Ship budget-constrained always-inject; keep the budget knob (§1.7). |
| **P5** | Adding parts can degrade the whole (V7: 138 feat < 43; V15: boost policy degraded rework + wall time). | Gate every policy change on whether the *whole* improves on a real outcome, prospectively, at equal quality. |
| **P6** | Dedup is behavior-shaping, not just an optimization (V15 §4b). | Do not bypass dedup without a measured reason. Forced re-injection of unchanged content causes agent loops. |
| **P7** | Static AGENTS.md performs comparably to dynamic injection on some tasks (V15: tied on quality + rework). | PipeMD's value must come from freshness + signal density + cross-harness, not from "dynamic beats static" as an article of faith. Invest in the content layer. |

---

## 3. Metric & measurement discipline — how to evaluate anything data-driven

| # | Lesson (evidence) | Action |
|---|---|---|
| **M1** | Question the objective before the metric (V8 false positive survived a phase). | Audit every metric: *success, or a proxy for success?* Write the definition down. |
| **M2** | Bench contamination manufactures false success (V5b AUC 0.92). | Isolate the bench from any product-learning data; exclude bench sessions by construction. **Bench runs must not contaminate `ml/` data** (V15 R-23). |
| **M3** | Label/feature leakage manufactures false success (V8 0.596). | Audit correlations for cross-file/cross-time/cross-session leakage. |
| **M4** | Cross-regime comparisons are invalid (V7 "+12.3%"). | Compare policies under identical conditions; never mix regimes in a headline. |
| **M5** | Retrospective ≠ prospective (V7 "100% prevention"; V10 R-1; V15 R-21). | "Helps/improves/prevents" claims require a prospective experiment, not retrospective correlation. |
| **M6** | Honest negative is a valid outcome (V6, V9, V10, V14, V15). | "Measured and doesn't beat baseline" stops the feature. Don't push past an honest negative. |
| **M7** | Observational learnability ≠ causal policy value (V15 §4c). | A predictive feature is necessary for a useful policy; it is not sufficient. The "direction" (more vs less, boost vs suppress) is not determined by the feature's predictive sign — it requires a prospective test. |
| **M8** | The bench is the only arbiter for policy *shape*, not just policy presence (V15 §7). | V15's negative bounds ONE shape (quantity-boost). The opposite shape (quantity-reduce/suppress) is untested. Test shapes, not just yes/no. |

---

## 4. Data-hygiene infrastructure — what `main` must preserve/reuse

| Asset | What it does | Main action |
|---|---|---|
| **Bench-session exclusion** (`clean_bench_sessions.py`) | Keeps data bench-free. | Port `is_bench_session` into any main telemetry/learning path. |
| **Coverage auditor** (`coverage_auditor.py`) | Pre-deployment NaN/const/outlier/N-DOF/merge-integrity gate. | Reuse for any main data pipeline; catches whole bug classes. |
| **Injection-log → outcome alignment** (`v10_treatment.py`) | Aligns "what was injected" to "what happened next." | Foundation of any feedback loop; enrich the log with in-record timestamps. |
| **Validated outcome metric** (`Y6_duration`) | First real (non-proxy) success measure. | Reuse as the primary injection-evaluation outcome. |
| **Temporal split + embargo** (`splits.py`) | Leak-free evaluation. | Any main evaluation uses temporal splits; future never trains present. |
| **Prospective A/B harness** (`bench/bench-agent.sh`, V15-extended) | Rework metric + `adaptive` condition + `--conditions`/`--scenarios` flags. | **The Layer 3 tool.** Powers any future prospective claim (ROADMAP §2B.4). |
| **Friction-channel decomposition** (`v14_friction.py`) | Decomposed efficiency formula (S/C/L/T/X/W/F/P/M). | Reusable measurement framework for per-block efficiency analysis. |

---

## 5. Engineering-culture lessons

| # | Lesson | Action |
|---|---|---|
| **C1** | 10 versions optimized a proxy before questioning the objective. | Measure the dumb/deterministic baseline on a real outcome *first*; add complexity only if it beats that, prospectively. |
| **C2** | A false positive (V8) survived a phase — no postmortem written. | Postmortem every reverted line of work, at the time. |
| **C3** | Cross-domain ports failed when target-fit wasn't checked (V6/V7). | Port the principle, then validate the target mapping before building. |
| **C4** | The decisive answer came from changing the question (V10, V15), not more features. | When an effort stalls across iterations, suspect the objective, not the technique. |
| **C5** | Small samples license false confidence both ways (V10 n=5; V15 n=3/cell). | Report sample size + power with every effect. Frame single-task results as signal-finding. |
| **C6** | The observational line hit a ceiling (V11–V14 R²≈0.13–0.29); the prospective test was decisive (V15). | Do not extend an observational line past its ceiling. The bench is the next step, not more features. |

---

## 6. Prioritized product roadmap for `main`

Ordered by evidence strength × value × low-risk (see `ROADMAP.md` for the full plan):

1. **(Now) Ship the topology filter in the active-mode baseline.** V7's 15×
   signal as a hard file-type gate. −30% tokens, zero ML, no caveat on the token
   dimension. *(P2, §1.4 — ROADMAP Phase 2A.1)*
2. **(Now) Ship the rewrite-tracker as dormant infrastructure.** Session-scoped
   edit counter; no consumer on main (the boost is cut). Exists for the suppress
   experiment + future rewrite-aware policies. *(ROADMAP Phase 2A.2)*
3. **(Now) Default `delivery: "active"`; keep `"learned"` as experimental stub.**
   The evidence-based product policy. *(P1)*
4. **(Now) Invest in resolver/content quality for the high-value blocks**
   (`file-content`, `file-errors`) — freshness, signal density. The content
   layer is where the measured value lives. *(§1.2, §1.3 — ROADMAP Phase 2C)*
5. **(Now) Reconsider weak blocks** (`git-context`, `crew-todos`) — conditional,
   not default-on. *(§1.2 — ROADMAP Phase 2.4)*
6. **(Next) Adaptive precision tiers** — role/engagement-driven `max-lines`
   (T0/T1/T2/T3). Opt-in (`delivery: "tiered"`), benched prospectively before
   default. *(§1.5, P3 — ROADMAP Phase 2C.4)*
7. **(Next) Token budget as a first-class lever** + budget-constrained
   always-inject default. *(§1.7, P4 — ROADMAP Phase 2C.5)*
8. **(Next) Dependency-graph leverage** beyond `import-graph`
   (dependents-at-risk, neighborhood error context). *(§1.6 — ROADMAP Phase 2C.3)*
9. **(Then) Multi-task prospective bench** — scale the V15 harness to scenarios
   1–5, n≥5/cell. The decisive validation of any future policy. *(M8 — ROADMAP
   Phase 2B.4)*
10. **(Preserve) Port `is_bench_session` + coverage auditor** into any main data
    path. *(§4)*
11. **(Defer / experimental) Test the suppress policy shape.** When
    `editCount ≥ 2`, SUPPRESS low-value blocks (the opposite of V15's boost).
    One prospective A/B on `experimental`. If it also loses, the ML-injection
    line closes on `main`. *(M8, P1)*
12. **(Defer) Re-evaluate ML selection** only if step 9 + 11 show per-context
    value beats the deterministic baseline. *(P5, C1, C6)*

---

## 7. Anti-patterns to never repeat

- Shipping a "smart" feature unmeasured against a deterministic baseline on a real outcome.
- Trusting a metric whose proxy-vs-success definition was never audited (V8).
- Letting eval/bench data contaminate the signal (V5b; V15 R-23).
- Mixing regimes in a headline comparison (V7).
- Calling a retrospective correlation a "prevention/improvement" (V7; V10 R-1).
- Adding parts that pass local tests but degrade the whole (V7; V15 boost).
- Forcing a feature past an honest negative (V9, V14, V15).
- Betting on an n=5 / n=3 effect, in either direction (V10, V15).
- Investing in ML selection before the content/resolver layer is strong (V10, V15).
- **Bypassing dedup without a measured reason** (V15: causes agent loops — P6).
- **Extending an observational line past its ceiling** instead of running the bench (V11–V14 → V15 — C6).
- **Trusting the "direction" of an observational signal** (more vs less injection) without a prospective test (V15 §4c — M7).

---

## 8. The one principle that generalizes

> **The block content is the product; complexity must earn its place against a
> measured baseline, on a real outcome, validated prospectively.**

V10 measured the average effect observationally; V11–V14 pushed the
observational ceiling (content-fit then friction) until V14's zero-common-
support result exposed the structural limit; **V15 walked the only remaining
path — a prospective A/B — and confirmed that the policy built from the two
most durable observational signals still loses to the simple default.** The
smartest *selection* lost to always-inject (twice: observationally in V10,
prospectively in V15), while the strongest reward was the file's own *content*.

Improve what you inject (resolvers, freshness, file-aware rendering, precision
tiers) before you try to smartly *select*; and whenever you add intelligence,
measure the dumb baseline on the real outcome first. Six versions of
observational work (V10–V14) were decisive only when followed by one
prospective test (V15) — carry that into every feature decision on `main`.

---

## Appendix — evidence index

| Lesson / finding | Source version(s) |
|---|---|
| Injection has average causal value (content layer matters most) | V10 |
| Per-block rewards: file-content/file-errors strongest; git-context/crew-todos weak | V10 |
| Topology (role/lang) is the durable deterministic signal (15× spread) | V7 §12; V12 rehabilitated; V15 shipped |
| Topology filter saves 30% input tokens at equal quality (free win) | V15 |
| Binary inject-or-not plateaus; cheap-middle tiers untested | V7, V8 |
| Freshness features (steps_since_lint/tsc) are top signals | V5, V7 |
| ML selection worse than always-inject (observational + prospective) | V10, V15 |
| The adaptive BOOST policy backfires (agent loops; dedup is behavior-shaping) | V15 |
| Observational learnability ≠ causal policy value | V15 §4c |
| Content-fit reward ceiling R²≈0.13–0.21; topology only cross-product-generalizer | V11, V12, V13 |
| Efficiency/friction composite not learnable; rewrite-rate +0.0123 (the one new durable signal) | V14 |
| Zero common support — per-block reward structurally unobservable observationally | V14 |
| File-level error onset unpredictable from trace features | V5, V9 |
| Reasoning-text keywords useless (sparse) | V1–V3, V5b |
| Proxy-objective failures; contamination; leakage; cross-regime; aggregate degradation | V5, V7, V8, V9 |
| Decontamination / auditor / temporal-split / injection-log alignment infrastructure | V6-second-pass, V8, V9, V10 |
| Prospective A/B harness (rework metric, equal-quality rule, signal-finding framing) | V15 |
| Friction-channel decomposition (S/C/L/T/X/W/F/P/M) | V14 |
