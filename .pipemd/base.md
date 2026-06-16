<!-- Governance summary — do not edit via write-back. Full rules: docs/discipline.md -->

# Project Discipline

Two lanes: **main** (product — shippable, single-machine flawless) and
**experimental** (incubator for fleet fabric). The ROADMAP's "What We're
Not Doing" applies to main only. If you can't tell which side a change is
on, it's infra — it stays on experimental. Full rules: `docs/discipline.md`.

**Definition of Done:** committed; tests wired into `test:unit`; `tsc
--noEmit` clean; `eslint src/` clean. On main additionally: single-machine
suites green; FIFO e2e FAILs (not SKIPs) on regression; Layer 2 contract
for any new block/resolver; ROADMAP updated if phase boundary shifts.

**Relay federates, doesn't orchestrate.** Test: if the relay is choosing
who/when, it's orchestration; if it's forwarding a caller's decision, it's
transport.

**Verify before trusting.** A worker's "done" is unverified until the
branch is fetched and checked against actual code.

**Measure, don't guess.** No new block/resolver on main without a Layer 2
contract (token, latency, accuracy). No bench counts as evidence with a
contaminated control arm.

**Product preempts infra.** A defect in the shipped product wins over
fabric work. Single-machine flawless before distributed.

Open findings: `docs/review-findings.md`.
