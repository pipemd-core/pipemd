# PipeMD Agent Benchmark v2 — Quality Rubric

Each scenario is graded on a 0–2 quality scale by a **native** gate
(tsc+vitest / lua / pytest+ruff / go test+gofmt — never a grep). The grade
determines whether a run's efficiency metrics are comparable to other runs at
the same quality level.

## Grade 2 — Complete

The implementation:

- Passes the native toolchain (compile + lint + the bench-owned grade spec)
- Contains no obvious logic errors (the feature does what was asked)
- Follows the project's existing patterns and conventions
- Does not break existing functionality (the project's own test suite still passes)
- All files created/modified are syntactically valid

## Grade 1 — Partial

The implementation:

- Compiles / type-checks (tsc, go vet/vet, ruff, lua -c) but
- Partially implements the requested feature (e.g. missing an edge case,
  incomplete integration, compiles but the grade spec fails), OR
- Has a minor pattern violation (e.g. doesn't follow the exact middleware
  signature convention)

## Grade 0 — Broken

The implementation:

- Does not compile / lint, OR
- Creates syntax errors in existing files, OR
- Is missing entirely (agent didn't produce the output), OR
- Modifies files in a way that breaks the project structure

## Task shape — "middle-length"

Every v2 scenario is **middle-length**: the agent must read 3–6 files to learn
the relevant patterns, touch 2–4 files (create + modify), and pass a native
gate. This is the regime where context (file map, conventions, build commands)
should help — not trivial one-liners, not multi-day refactors. ~2–8 min of agent
work.

## Quality gate process

Each scenario has a `quality/check-0N.sh` that:

1. Injects a bench-owned grade spec (the agent never sees it during exploration)
   at grade time — vitest spec / pytest / `_bench_test.go`. The lua gate runs an
   external grader that builds its own tree.
2. Runs the project's native compile + lint + the injected spec.
3. Emits a single integer grade (0, 1, or 2).

## 3-condition design

- **WITH** — daemon + opencode plugin + live `<!-- pmd: -->` injection.
- **PASSIVE** — one rendered snapshot, daemon killed (frozen).
- **STATIC** — a hand-written-style AGENTS.md (no pmd blocks), the realistic
  control. 99% of real projects ship a static context file, so STATIC is the
  honest baseline. **The headline verdict is WITH vs STATIC**: does *dynamic*
  injection beat a *normal static* AGENTS.md?

## Reporting rule

Efficiency metrics (tokens, tool calls, wall time) are **only compared** between
runs that achieved the same quality grade. A Grade-0 run with 8 tool calls does
not "beat" a Grade-2 run with 22 tool calls.

## What v2 changed vs v1

- The bare **WITHOUT** arm (no context at all) is replaced by **STATIC**
  (hand-written AGENTS.md). v1 was "PipeMD vs nothing" — unrealistic.
- The self-referential `pipemd-doctor` task is dropped (COI + it failed without
  context). The portfolio now spans TS / Lua / Python / Go to prove (or expose)
  generalization across ecosystems.
- Quality gates are native tooling (tsc+vitest / pytest / go test / lua), not
  grep patterns.
- v1 results are NOT comparable to v2 (different control arm + different tasks).
