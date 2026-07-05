# Project Discipline

This is the canonical governance doc for branching, lanes, and quality
bars. A trimmed agent-facing summary lives in `.pipemd/base.md` (prepended
to every context render). This doc coordinates with `ROADMAP.md` — the
ROADMAP is the source of truth for *what* and *when*; this doc is the
source of truth for *how* work is organized to get there.

---

PipeMD is two things at once — a product (the context engine, shipped as
`@pipemd-core/pipemd`) and, on a separate track, an incubator for a networked
agent fleet (federation, cross-machine dispatch, PTY takeover, the Hermes
control plane). They have different quality bars and must not share a body.
Two long-lived branches keep them apart.

## Lanes

- **main** — the product. Bar: shippable, single-machine flawless, broad
  agent support. Admits only validated, product-grade work.
- **experimental** — the incubator. Build freely here. Where everything new
  is built and integrated: the fleet fabric and any feature not yet proven
  product-grade. Bar: works end-to-end, `tsc --noEmit` clean, `eslint src/`
  clean, rebases cleanly on main.

## The Line, and How to Cross It

The ROADMAP's "What We're Not Doing" list applies to **main**. Items marked
**Cut** there (e.g. agent fleet orchestration, mesh gossip) may be incubated
on **experimental**; they reach main only through the promotion gate below.
If you can't tell which side a change is on, it's infra — it stays on
experimental.

A feature crosses experimental → main when ALL of:

1. It fits the product side of the line — context delivery or sharing
   (e.g. `GET /workspace/:id/context`). Fleet control (e.g. `/fleet`,
   dispatch proxy, PTY takeover) stays on experimental.
2. The ROADMAP's current-phase exit criteria are met for the affected area.
3. A Phase 2B Layer 2 contract exists for any new block or resolver
   (token budget, latency budget, accuracy golden).
4. Single-machine suites are green, including the FIFO e2e — which MUST
   fail, not SKIP, on regression.
5. The change is small, atomic, and reviewed on its own.

## Principles

1. **Single-machine flawless before distributed.** No fabric work proceeds
   while the single-machine context path has a known correctness bug. This
   is the ROADMAP's Phase 2 → Phase 3 gate, treated as hard. "Flawless" is
   not aspirational: it means the ROADMAP's Phase 2 success criteria are
   met, Layer 2 is green, and there are no open Critical or High
   correctness or security findings against the core path (see
   `docs/review-findings.md`).
2. **Product preempts infra.** When the two compete for the same change or
   the same hour, a defect in the shipped product wins. The fabric can
   wait; the product has users.
3. **The relay federates and gatekeeps; it does not orchestrate.** It may
   observe (`opencode serve` SSE), aggregate (`/fleet`), authorize, and
   proxy. It must not schedule, assign tasks, spawn agents, or own
   orchestration logic. Test for any new endpoint: if the relay is choosing
   who or when, it's orchestration; if it's forwarding a decision the
   caller already made, it's transport. Hermes decides, opencode executes,
   the relay transports and guards the door.
4. **Written ≠ committed; verify before trusting.** A worker's or
   orchestrator's "done" is unverified until the branch is fetched and the
   claim is checked against the actual code and refs. Publish a contract
   (paths, JSON shapes, endpoint names) before any consumer wires against it.
5. **Measure, don't guess.** No new block or resolver reaches main without
   a Layer 2 contract. No bench run counts as evidence if its control arm
   is contaminated (the WITHOUT and PASSIVE conditions must be truly free
   of PipeMD artifacts). Regressions are caught in CI, not by agents.

## Branch Hygiene

- Two long-lived branches only: **main** and **experimental**. Everything
  else is short-lived.
- **experimental is additive, not mutative**, for new fabric modules. It
  adds modules that import core; it must not rewrite core context-delivery
  files beyond an agreed mount point. Core hardening required by the
  product bar (per-resolver timeouts, dedup TTL, permission fixes, etc.)
  lands on **main** as hotfixes; experimental then rebases to pick them up.
- **Rebase, don't diverge.** Pull main into experimental regularly so the
  incubator always sits on top of the hardened core. Never let them drift
  into a merge swamp.
- **Promote in slices.** Graduate one validated feature at a time from
  experimental to main — small, atomic, reviewed. Never merge the whole
  incubator.
- **Hotfixes bypass the incubator.** Product-critical fixes branch off
  main and land on main; experimental then rebases to pick them up.
- **Task branches are ephemeral.** Parallel work spins a short-lived
  branch off experimental and merges back fast, then is deleted. Task
  branches must never become long-lived forks.

## Definition of Done

- **On either lane:** committed (not just written); new tests wired into
  `test:unit`; `tsc --noEmit` clean; `eslint src/` clean; `CHANGELOG.md`
  entry added for any user-visible change.
- **On main, additionally:** single-machine suites green; FIFO e2e fails
  (not SKIPs) on regression; Layer 2 contract committed for any new block
  or resolver; `ROADMAP.md` updated if the change shifts a phase boundary.
