# PipeMD Roadmap

*Last updated: 2026-05-24*

> **PipeMD is for AI-augmented developers who want their agents — solo or in teams — to share grounded, up-to-date project context.**

## The Promise

**Today:** Always-fresh project context, injected on every tool call, with zero git churn.

**The Vision:** A distributed network of agents effortlessly sharing context across machines.

The gap between today and the vision is bridged by making the core unbreakable, the context undeniable, and local coordination proven — *before* we distribute it across a network.

## Who Benefits When

| Phase | Persona | Headline Benefit |
|-------|---------|------------------|
| **1. Core & DX** | Solo developers using any agent | Agents stop hallucinating — they read live project state on every tool call |
| **2. Local Swarms** | Small teams running parallel agents | Multiple agents work in parallel without stepping on each other |
| **3. Distributed** | Fleet operators with distributed infrastructure | Agents across machines share one source of truth |

---

## Scorecard

| Phase | Exit Criterion | Rough Size | Status |
|-------|---------------|------------|--------|
| **1a. Adapter & Visibility** | New harness = <1 new file, <100 LOC. | Small | In Progress |
| **1b. Block Library & DX** | `test-failures` + `context-rules` blocks ship. Cursor + Aider supported. `pmd run` CI-ready. | Medium | Planned |
| **2. Local Swarms** | Crew supports 3+ coordination patterns. 3+ documented teams running multi-agent crew daily. | Medium | Planned |
| **3. Distributed** | Power users explicitly request cross-machine crew sync. Relay ships with auth + persistence. | Large | Paused |

---

## Phase 1a: Adapter Refactor & Dev Visibility
*Unblock the ecosystem. Required before anything else.*

If adding a new AI agent takes touching 5 files and 900 lines of string concatenation, the ecosystem won't grow. Phase 1a is the gate — everything else depends on a clean Adapter API.

- **Harness Adapter Refactor:**
  - Dismantle `opencode-hooks.ts` string-template codegen (914 lines of string concatenation — the project's largest technical debt).
  - Formalize the Adapter API so adding a new harness is one file, under 100 lines.
- **Dev Visibility:**
  - Improve CLI output so developers see *what* context is injected and *when*.
  - Provide debugging tools to visualize the named-pipe payload at any moment.

## Phase 1b: Context Block Library & Developer Experience
*Ship continuously after 1a lands.*

Blocks are the atomic unit of PipeMD's value. Each block is one emitter — a bash script, a file read, or a path-matching rule — that feeds the injection pipeline. No architectural change per block. The community contributes more via block emitters.

- **Flagship Blocks (ship first):**
  - **`test-failures`** — live tail of failing tests + assertion diff. The agent sees red tests on its next tool call and fixes them without being asked. Closes the TDD loop. Proves the pipeline is live, not just a file reader.
  - **`context-rules`** — *Right context, right place, zero token waste.* Glob patterns in `injection.yml` map file paths to relevant architecture decisions, style guides, or API contracts. The agent only sees the rules that apply to *where it's working*. This is a category-defining feature — no other context tool delivers spatially-aware injection.

    ```yaml
    # .pipemd/injection.yml
    context-rules:
      - pattern: "src/billing/**"
        inject: "docs/ADR-004-stripe-webhooks.md"
      - pattern: "src/ui/**"
        inject: "docs/tailwind-guidelines.md"
    ```

  - **`auto-docs`** — TypeScript `.d.ts` extraction for npm dependencies. Compact, greppable API surfaces injected as `<!-- pmd: docs:<package> -->` blocks. Agents stop guessing library signatures.

- **Block Library Candidates (community-contributable):**
  - `runtime-errors` — dev server stderr / browser console errors.
  - `issue` — issue body auto-detected from branch name (GitHub, Linear, Jira).
  - `review` — open PR review comments on current branch.
  - `schema` — current DB schema + pending migrations.
  - `build-status` — last CI run state + failing step tail.
  - `handoff` — cross-agent notes ("Agent A: done with auth.ts, B start tests").
  - `audit` — dependency vulnerability report.

  Each is one file, one emitter, no architectural change.

- **Ecosystem Expansion:**
  - Ship scaffold + detect for **Cursor** and **Aider** in `pmd init`.
  - Feature parity with Claude/Gemini/OpenCode hooks.

- **First-Class CI/CD (`pmd run`):**
  - Polish one-shot, daemon-less runs for automated pipelines.

## Phase 2: Local Swarms (Crew & Multi-Agent)
*Prove coordination on a single machine before distributing it.*

Crew coordination already ships (file claims, status broadcasts, sub-agent hierarchies). Phase 2 makes it production-grade and validates that multi-agent workflows are a real use case — not just a demo.

- **Crew Coordination Patterns (building on shipped primitives):**
  - Claim TTL tuning — auto-release stale claims after configurable timeout.
  - `pmd crew watch` — live TUI showing session tree, file locks, and injection events.
  - Cross-harness conflict resolution with real-time UI in `pmd trace`.
  - `handoff` block — cross-agent notes for task transfer between agents.
- **Use-Case Validation:**
  - Document 3+ real teams running multi-agent crew daily (frontend/backend splits, research/coder splits, test/implementation splits).
  - Gather feedback on conflict resolution patterns and missing coordination primitives.

## Phase 3: The Distributed Future (`pmd link`)
*Expand to the network when the design is proven and the use case is clear.*

The in-memory relay exists today (~840 LOC in `src/core/net/`) with plain HTTP, bearer-token auth between peers, and no persistence. It works for LAN demos.

Open design questions that must be resolved before active development:
- **Cross-branch coordination**: agents on different machines may work different branches — how does the fleet share a coherent view?
- **Shared vs. dedicated objectives**: should fleet agents share one task queue or work independent goals?
- **Block sharing vs. session-only**: should the relay share rendered blocks (full context) or just crew sessions (coordination)?
- **Discovery**: mDNS for LAN? Manual peers? A registry service?

- **Market Signal Requirement:** Resume active development when the design questions above have answers validated by real usage.
- **Evolution Path (when triggered):**
  - Block sharing via relay (agents on remote machines see full project context).
  - Encrypted peer sync (TLS, not plain HTTP).
  - Discovery protocol (mDNS for LAN, manual for WAN).
  - Conflict resolution across machines.

---

## What We're Not Doing

Explicitly deprioritized to protect focus:

| Item | Status | Why |
|------|--------|-----|
| Link relay persistence | Paused | Phase 3 is gated on market signal |
| Mesh gossip protocol | Cut | Premature — star topology suffices |
| SSH tunnel management | Cut | Users can compose with existing tools |
| Team mode / RBAC | Cut | Single-user DX must be flawless first |
| Auto-docs for non-TS ecosystems | Deferred | TS `.d.ts` extraction is the MVP; other ecosystems are community blocks |
| Custom DSL or sandboxing | Cut | Blocks are bash scripts. No new runtime, no new language. |
| Editor integrations (cursor position, selection) | Cut | Different product surface. PipeMD injects on tool calls, not keystrokes. |

The 7 ecosystem script directories (C-CPP, Rust, Python, Go, Node-TypeScript, Generic, DevOps) ship with `pmd init` and are community-maintainable. They prove the injection model works across ecosystems — they are not a core development priority.

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| **Agent vendors ship native injection** (e.g., Claude Code reads git status natively) | Medium | PipeMD's moat is cross-agent universality. Vendor-native solutions fragment across ecosystems. Stay harness-agnostic. |
| **Context tools ship blocks first** (Context7, Repomix) | Medium | Individual blocks are easy to replicate. The injection pipeline + adapter API is the product. Blocks are inputs, not the moat. |
| **Solo agents dominate, crew has zero pull** | Medium-High | Phase 2 is validation-gated. If multi-agent workflows don't materialize, skip to Phase 3 (distributed single-agent context sync) or pivot. |
| **Named pipes break on new platforms** (Windows, containers) | Low | Legacy mode (file watcher) is a first-class fallback, not a second-class citizen. |
