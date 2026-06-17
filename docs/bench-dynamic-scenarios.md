# Dynamic-Value Benchmark Scenarios — Design

Status: **design** (not yet implemented). Gated behind the "do-no-harm floor"
re-bench being clean — see Sequencing.

## Why this exists

The v2 bench (`bench/results/run-20260617-130751`) is deliberately the honest
**single-machine floor**: single agent, static codebase, fresh start. Under
those conditions a hand-written `AGENTS.md` (STATIC) is near-optimal, because
the signals PipeMD's *live* machinery exists to deliver are all empty:

| Live signal            | Floor-bench state   | STATIC can carry it? |
|------------------------|---------------------|----------------------|
| `crew-status` / locks  | 1 agent, no overlap | n/a (empty)          |
| mid-task file delta    | codebase frozen     | yes (nothing changes)|
| handoff / resume state | fresh start         | n/a (nothing to carry)|

So the floor measures "does injection tax the easy case?" — and the v2 verdict
(token regression, equal quality) is the honest answer: **it did tax it, and
that is being fixed** (Tracks 1–2: suppress-on-error, deps reforge, file-errors
freshness). The floor must reach token-parity with STATIC before any dynamic
claim is credible.

But the floor is structurally blind to the dimension PipeMD was built for. This
doc defines a **second scenario class** that probes exactly the capabilities a
static file cannot provide. None of these overfit to a task — each measures a
project-structural property.

## The three scenarios

Each scenario has the same shape as the floor tasks (middle-length, native
gate, N≥3) but introduces a **change mid-run** that makes the static `AGENTS.md`
wrong by the time the agent needs it.

### D1 — Codebase-changes-mid-task

**Hypothesis:** when a sibling file the agent depends on is edited *while the
agent works*, live injection delivers the delta; a frozen snapshot (STATIC and
PASSIVE) is stale and the agent acts on outdated information.

**Setup:** two-file contract. The agent edits `consumer.ts` whose import target
is `provider.ts`. After the agent has read `provider.ts` and started editing, a
**bench-driven hook** rewrites `provider.ts` (changes an exported signature:
rename, or arity +1). The agent must adapt `consumer.ts` to the new signature.

**What STATIC cannot do:** the static `AGENTS.md` was rendered before the run;
it never sees the `provider.ts` change. PASSIVE's frozen snapshot is equally
blind. Only WITH (live `git-delta` / `import-graph` resolver, re-rendered per
turn) surfaces "provider.ts changed 30s ago — here's the diff."

**Gate (native):** `tsc --noEmit` on `consumer.ts` against the *new* `provider.ts`.
STATIC/PASSIVE fail to compile (they wired against the old signature); WITH
passes (it got the delta). Quality grade is binary: compiles against new API or
not.

**Layer 2 contract:** token delta WITH-vs-STATIC ≤ +X%; WITH wall ≤ STATIC
wall × 1.5; accuracy = WITH gate ≥ STATIC gate by ≥2 quality grades. If WITH
can't win accuracy here, the live-delta claim is false.

### D2 — Multi-agent / crew (overlapping files)

**Hypothesis:** when two agents edit overlapping files concurrently, the crew
conflict/lock resolvers finally have signal; WITHOUT coordination, the second
writer clobbers the first or both produce inconsistent merges.

**Setup:** two agent processes (same model), two tasks that both touch
`shared.ts` (one adds a function, one refactors an adjacent function). They run
concurrently. WITH arm: both agents run under PipeMD crew (heartbeat + lock
claims). STATIC arm: two bare `opencode run` with a static `AGENTS.md`, no
coordination.

**What STATIC cannot do:** a static file cannot know another agent is editing
`shared.ts` right now. The crew lock resolver (`resolveCrewLocks`,
`injection-engine.ts`) returns `⚠️ CONFLICT` only for live sessions.

**Gate (native):** `tsc` clean **and** a structural check that both intended
changes are present in the final `shared.ts` (no clobber). STATIC routinely
clobbers (last writer wins); WITH surfaces the conflict and serializes.

**Layer 2 contract:** conflict-detection latency < 1 turn; WITH merge-success
rate > STATIC by ≥30 pts; token cost of crew chatter < 5% of prompt.

**Relay-discipline check** (`AGENTS.md`): this scenario uses crew for *transport*
(forwarding lock state between the two local agents), not orchestration — the
agents decide what to edit; PipeMD forwards the claim. If the harness starts
*choosing* who edits what, it has crossed the line.

### D3 — Resume-after-interruption

**Hypothesis:** when an agent is killed mid-task and a fresh agent resumes,
injection carries forward the handoff/tasks state; a fresh STATIC start re-derives
context from scratch (re-reading, re-exploring) or fails to recover the
in-progress intent.

**Setup:** run a multi-step task to ~50% completion, kill the agent, start a
fresh agent on the same work_dir with only "continue the task" as the prompt.
WITH arm: the `handoff` resolver (`injection-engine.ts`) + tasks ledger carry
the prior state into the resume. STATIC arm: a static `AGENTS.md` has no memory
of the prior session.

**What STATIC cannot do:** carry session state. The static file is identical
before and after the kill.

**Gate (native):** the task's native gate (compile/test) must pass after resume,
**and** the resume agent must not redo work the killed agent already completed
(measured by edit-count: WITH resume re-edits fewer already-correct files).

**Layer 2 contract:** resume-success rate WITH > STATIC; redundant re-edits WITH
< STATIC × 0.5; handoff token cost < 2k tokens.

## What this is NOT

- **Not overfitting.** Each scenario measures a structural property (delta
  delivery, coordination, state carry), not a tuned-to-four-tasks trick. The
  bench repos (hono/bt-lua/cachetools/uuid) can be reused with new prompts.
- **Not a replacement for the floor.** The floor (D0) stays as the "do-no-harm"
  gate. Dynamic scenarios are additive: D0 must be clean before D1–D3 run.
- **Not infra/fleet.** D1 and D3 are single-machine. D2 is two agents on one
  machine. Per `AGENTS.md` ("single-machine flawless before distributed"), none
  of this requires the relay/fabric — that's a later lane.

## Sequencing

1. **Floor clean first.** Re-bench D0 (the existing v2 scenarios) after Tracks
   1–2 land. Target: WITH reaches token-parity (within the +100% guard) with
   STATIC at equal quality. Until then, dynamic claims are premature.
2. **D1 next** (highest signal-to-complexity: one extra hook, no second agent).
3. **D3** (handoff resolver already exists; lowest new infra).
4. **D2 last** (two-agent harness is the most bench-engineering work; also the
   one that brushes closest to the orchestration line — needs the discipline
   review before landing).

## Open questions

- **D1 timing:** how to trigger the mid-run `provider.ts` edit deterministically?
  Candidate: bench polls the agent's ndjson for the first edit to `consumer.ts`,
  then fires the `provider.ts` rewrite. Needs a small orchestrator that does
  *not* touch the agent's process — only the filesystem (keeps it transport, not
  orchestration).
- **D2 fairness:** two concurrent `opencode run` may contend for the same model
  rate limit, inflating wall time equally for both arms. Token/quality gates
  matter more than wall for D2.
- **D3 kill point:** "50% complete" is fuzzy. Define kill point structurally:
  after the agent has made ≥3 edits but before the gate would pass.

---

Each scenario gets its own Layer 2 contract before implementation, per the
`AGENTS.md` rule: *no new block/resolver on main without a Layer 2 contract
(token, latency, accuracy)*. The dynamic scenarios don't add blocks — they
exercise existing resolvers (`git-delta`, `crew-locks`, `handoff`) under
conditions where they have something to say.
