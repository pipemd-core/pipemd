# Track A Promotion Spec — Topology Filter + Rewrite Tracker to `main`

> **Status:** Ready to execute. This is the exact spec for promoting the two
> V15 main-lane-clean artifacts from the `ml` branch to `main`.
> **Authority:** `ROADMAP.md` Phase 2A, `docs/ml-lessons-for-main.md` §6 items 1–2.
> **Discipline:** `docs/discipline.md` — single clean commit on `main`, full DoD.

---

## 1. What this promotion does (and does NOT) do

### Ships
- **Topology filter** in the **active-mode baseline** (the default). V7's 15×
  label-spread signal as a hard file-type gate. V15 measured −30% input tokens
  at equal quality. Zero ML.
- **Rewrite tracker** as **dormant infrastructure**. Session-scoped per-file
  edit counter. No consumer on `main`; exists for the suppress-shape experiment
  (`experimental`) and future rewrite-aware policies.

### Does NOT ship (V15 disproved these)
- The **adaptive BOOST** logic (force re-injection when `editCount ≥ 2`).
  V15 §3: adaptive boost increased rework (1 vs 0) and wall time (2.1×) at equal
  quality. The agent looped on unchanged context. **Do not promote.**
- The **`recordEdit` call** from `resolveInjections`. Without the boost consumer,
  recording edits is dead work on main.
- **`delivery: "adaptive"` as a scaffolded default.** `pmd init` keeps writing
  `delivery: "active"`.

### Net behavior change for users
None visible except **fewer tokens on non-JS/non-lintable file edits** (the
topology filter skips impossible injections). No new config, no breaking change.

---

## 2. The promotion mechanics — single clean commit

**Do NOT cherry-pick the V15 commits** (`343af92`, `e7bc1dc`, `b5534de`). They
carry the adaptive boost logic, the bench harness extension, and the scaffold
change — none of which belong on `main`. Instead, create a single clean commit
that adds only the two artifacts and the minimal engine wiring.

### 2.1 New files (copy verbatim from `ml`)

| File | Source | LOC | Tests |
|---|---|---:|---:|
| `src/core/topology-filter.ts` | `ml` branch, 104 LOC | 104 | 100 (separate file) |
| `src/core/rewrite-tracker.ts` | `ml` branch, 118 LOC | 118 | 19 (separate file) |
| `tests/test-topology-filter.ts` | `ml` branch | — | 100 tests |
| `tests/test-rewrite-tracker.ts` | `ml` branch | — | 19 tests |

These four files are self-contained. Copy them as-is. No modifications needed.

### 2.2 Modified file: `src/core/injection-engine.ts`

**Two surgical changes. Nothing else in this file.**

#### Change 1 — add the topology import (line ~24)

Add after the existing imports:
```ts
import { topologyAllows } from "./topology-filter.js";
```

**Do NOT add** the rewrite-tracker import (`import { recordEdit, editCount } from "./rewrite-tracker.js"`).
The tracker ships as dormant code; the engine does not call it on main.

#### Change 2 — widen the topology filter to fire in active mode (line ~896)

In the `applicableRules.filter(...)` block, change:
```ts
if (config.delivery === "adaptive" && !topologyAllows(rule.source, targetFile)) return false;
```
to:
```ts
if (!topologyAllows(rule.source, targetFile)) return false;
```

This makes the topology filter fire under `delivery: "active"` (the default) and
`delivery: "adaptive"`, not just adaptive. Passive has no rules; expert is
user-controlled; learned falls back to active.

**Do NOT add** any of these (all part of the disproved boost):
- The `ADAPTIVE_BOOST_SOURCES` constant (~line 43)
- The `ADAPTIVE_BOOST_MIN_EDITS` constant (~line 52)
- The `recordEdit(effectiveSessionId, targetFile)` call (~line 862–865)
- The `adaptiveBoostActive` computation (~line 882–884)
- The dedup bypass: `(adaptiveBoostActive && ADAPTIVE_BOOST_SOURCES.has(rule.source))` (~line 958–960)

### 2.3 Modified file: `src/core/injection-types.ts`

Add `"adaptive"` to the delivery mode plumbing so configs referencing it parse
without error (it's a valid opt-in, even though it behaves identically to
`"active"` on main — the boost logic isn't here).

- `DeliveryMode` type: add `"adaptive"` (line ~7)
- `VALID_DELIVERY_MODES` array: add `"adaptive"` (line ~58)
- `parseInjectionConfig`: the adaptive-with-no-rules fallback to
  `DEFAULT_ACTIVE_RULES` (lines ~221–229 on `ml`). On main, adaptive parses to
  the same rules as active; the only difference is the label.
- `generateInjectionYml` header comment: document `adaptive` as
  "active + topology filter (boost is experimental-lane only)".

### 2.4 Files NOT modified

| File | Why not |
|---|---|
| `src/commands/init/scaffold.ts` | `pmd init` keeps writing `delivery: "active"`. Do NOT write adaptive. |
| `bench/bench-agent.sh` | Bench harness extension stays on `ml`/`experimental`. |
| `src/core/learned-policy.ts` | Already on main as a skeleton. No change. |

---

## 3. Tests

### Copy from `ml` (verbatim)
- `tests/test-topology-filter.ts` — 100 tests covering all source × extension combinations.
- `tests/test-rewrite-tracker.ts` — 19 tests covering session scoping (R-22), LRU sweep, rate computation.

### Add one new test to `tests/test-injection-engine.ts`

```ts
it("topology filter fires under delivery: active (V15 — the free win)", async () => {
  // syntax-check should be skipped for a .css file even in active mode
  const payloads = await resolveInjections("before-edit", "src/style.css", "test-session-topology");
  const sources = payloads.map(p => p.source);
  assert.ok(!sources.includes("syntax-check"), "syntax-check must be skipped for .css");
  assert.ok(!sources.includes("import-graph"), "import-graph must be skipped for .css");
  assert.ok(!sources.includes("file-errors"), "file-errors must be skipped for .css");
});
```

### Do NOT copy from `ml`
- The V15 adaptive boost tests in `test-injection-engine.ts` (lines ~339–398 on
  `ml`: "adaptive records edits on before-edit/after-edit", "active delivery
  mode does NOT touch the rewrite tracker"). These test the boost recording
  logic that is intentionally absent from main.

### Copy from `ml` (test-injection-types.ts)
- The two adaptive parsing tests (lines ~69–86 on `ml`): adaptive is parsed and
  retained; adaptive with no rules falls back to `DEFAULT_ACTIVE_RULES`.

---

## 4. Definition of Done (discipline.md — binding)

All must pass on `main` after the single commit:

- [ ] `pnpm tsc --noEmit` — 0 errors
- [ ] `pnpm eslint src/` — 0 errors (warnings unchanged)
- [ ] `pnpm test:unit` — all green, including the 119 new tests (100 topology + 19 rewrite)
- [ ] `pnpm test:parity` — 16/16 pass
- [ ] `pnpm test:e2e` — 81 scripts pass
- [ ] **FIFO e2e must FAIL on regression, not SKIP** (discipline.md hard gate)
- [ ] The new "topology filter fires under active mode" test passes
- [ ] No adaptive boost code in `injection-engine.ts` (grep for `ADAPTIVE_BOOST`, `recordEdit`, `editCount` → 0 hits in that file)
- [ ] `ROADMAP.md` Phase 2A success criteria checked off
- [ ] Single commit message: `feat(core): ship topology filter in active baseline + dormant rewrite-tracker (V15 wins)`

---

## 5. Verification commands

```bash
# After the commit on main:
pnpm tsc --noEmit && pnpm eslint src/ && pnpm test:unit && pnpm test:parity
rg "ADAPTIVE_BOOST|recordEdit|editCount" src/core/injection-engine.ts  # must return nothing
rg "topologyAllows" src/core/injection-engine.ts                       # must show the filter line
```

---

## 6. Post-promotion: rebase downstream

After the commit lands on `main`:
- `experimental` rebases onto `main`. The adaptive boost code on `experimental`
  will need to be reconciled: the import of `rewrite-tracker.js` and the boost
  logic re-insert into `injection-engine.ts` on top of the new topology line.
- `ml` is archived (the research is closed). Its artifacts (reports, CDCs, data)
  are preserved as read-only reference; no further commits.

---

## 7. Why a single clean commit, not a cherry-pick

The V15 commits on `ml` (`343af92`, `e7bc1dc`, `b5534de`) bundle three concerns:
1. The two shippable artifacts (topology filter + rewrite tracker) — **ship**.
2. The adaptive boost logic in `injection-engine.ts` — **do not ship** (V15 disproved it).
3. The bench harness extension + scaffold change — **do not ship** (experimental-lane).

Cherry-picking would carry (2) and (3) into `main`, violating the discipline
doc's "small, atomic, reviewed on its own" rule and shipping code the research
explicitly rejected. A single clean commit that adds only the two artifacts and
the one-line engine change is the correct promotion.
