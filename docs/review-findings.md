# Review Findings

Living tracker of correctness, security, performance, and methodology findings
against the PipeMD codebase. Maintained per review cycle.

**Latest review:** 2026-06-16 — full critical review (core engine, benchmark,
plugin, security, direction/tests).

**How to maintain:** When a finding is fixed, change its status to `fixed` and
reference the commit SHA. Do not delete findings — the history is the audit
trail. New reviews append new findings with incremented IDs.

**Severity legend:** C = Critical, H = High, M = Medium, L = Low.

**Status legend:** open = unfixed, progress = fix in flight, fixed = resolved
(with SHA), wontfix = accepted risk (with rationale).

---

## Summary

| Area | Open | Fixed | Wontfix |
|------|------|-------|---------|
| CORE — injection engine, daemon, pipe-manager | 4 | 13 | 0 |
| BENCH — agent A/B harness, methodology | 8 | 5 | 0 |
| PLUG — OpenCode plugin, hook adapters | 7 | 5 | 0 |
| SEC — relay, crew, threat model, permissions | 6 | 8 | 0 |
| STRAT — strategy, tests, claims, docs | 9 | 5 | 0 |
| **Total** | **34** | **36** | **0** |

---

## CORE — Injection Engine, Daemon, Pipe-Manager

| ID | Sev | Status | Finding | Location |
|----|-----|--------|---------|----------|
| CORE-001 | C | fixed | Per-resolver timeout not enforced. No `Promise.race`/`AbortController` anywhere. The 5s `RESOLVER_TOTAL_BUDGET_MS` is checked at top of each iteration *after* awaiting the previous resolver. `resolveTestFailures` uses `timeout:30000` — 6x the budget. One hung git/grep stalls all injections for 5-30s. | `injection-engine.ts:752-808` |
| CORE-002 | H | fixed | Resolvers awaited serially in `resolveInjections`, contradicting README's "concurrent" claim. `injector.ts:69` uses `Promise.allSettled` — the active path doesn't. | `injection-engine.ts:752` |
| CORE-003 | H | fixed | `_isRendering` boolean silently drops renders under load. No queue, no "render again when free." Effective cadence drifts from current state. | `pipe-manager.ts:213-216` |
| CORE-004 | H | fixed | Write-back buffer grows without bound. `incomingBuffer += chunk` with no cap → OOM on stuck writer. `handleIncomingWrite` then runs regex over unbounded input. | `pipe-manager.ts:254-265` |
| CORE-005 | H | fixed | Dedup has no per-source TTL. Content-hash equality suppresses forever. Stable output ("No syntax errors") is suppressed indefinitely; agent can't distinguish from "PipeMD broken." | `dedup.ts:74-90` |
| CORE-006 | H | fixed | `resolveImportGraph` runs two full-tree `grep -r src/` per before-edit, cached per-file (10s TTL). Opening N files = N tree scans. Seconds per edit on large repos. | `injection-engine.ts:457-501` |
| CORE-007 | H | fixed | `triggerAsyncValidation` runs full `tsc --noEmit` on whole project per edit, then filters to file. 5-15s CPU per edit. | `injection-engine.ts:839-855` |
| CORE-008 | H | open | `config.yml` `commands:` is arbitrary code execution by design. Committed `.pipemd/config.yml` = RCE on every dev who runs `pmd start`. No signature, no allowlist, no blessing. | `pipe-manager.ts:180`, `injector.ts:78` |
| CORE-009 | H | fixed | `createPipe` unlink-then-mkfifo is TOCTOU-vulnerable. Symlink planted between unlink and mkfifo redirects agent-bound writes. | `pipe-manager.ts:72-89` |
| CORE-010 | H | open | "Sub-ms delivery" claim is false. Writer polls every 1000ms (`DEFAULT_RESERVE_DELAY_MS`); cold read = 0-1000ms (avg 500ms). Content served from polled cache, not rendered on read. | `pipe-manager.ts:279-304`, `config.ts:38` |
| CORE-011 | M | fixed | `recordInjection` non-atomic read-modify-write. Two `pmd inject` processes racing for same session → second write clobbers first. | `dedup.ts:74-78` |
| CORE-012 | M | fixed | `uncaughtException`/`unhandledRejection` kill the entire daemon. One buggy resolver rejecting without `.catch` takes down every pipe. | `daemon.ts:199-208` |
| CORE-013 | M | open | Two parallel render pipelines (pipe-mode `renderContentAsync` vs active `resolveInjections`) don't share logic, have different concurrency/error/caching models. | `injector.ts:56`, `injection-engine.ts:729` |
| CORE-014 | M | fixed | `resolveExports` regex misses `export { foo }`, `export * from`, `export type {`. Slow AND incomplete. | `injection-engine.ts:564-578` |
| CORE-015 | M | fixed | Cache layer uses synchronous fs I/O on hot path. 5-10 `existsSync`+`readFileSync`+`JSON.parse` per `resolveInjections` call. No in-memory layer. | `cache.ts:67-101` |
| CORE-016 | M | fixed | `resolveImportGraph` only regex-escapes `.` — `+[]()` unescaped, breaks on files like `utils[2].ts`. | `injection-engine.ts:441` |
| CORE-017 | L | fixed | `resolveFileErrors` is pure alias of `resolveValidation`. Two exported sources, one impl. | `injection-engine.ts:164-166` |

---

## BENCH — Agent A/B Harness, Methodology

| ID | Sev | Status | Finding | Location |
|----|-----|--------|---------|----------|
| BENCH-001 | C | fixed | WITHOUT condition for pipemd scenario contaminated. `setup_worktree` removes `.pipemd`/`AGENTS.md` but leaves `.opencode/plugin/pmd-crew.js` + `pmd-config.json{delivery:active}`. The "no PipeMD" cell has the active plugin firing. | `bench-agent.sh:506` |
| BENCH-002 | C | fixed | PASSIVE condition also contaminated. Same plugin stays active; `pmd inject` works without daemon. "Passive snapshot only" is a fiction. | `bench-agent.sh:547-569` |
| BENCH-003 | C | fixed | Token accounting double-counts system prompt. `input_tokens` sums per-step inputs, re-counting cached prefix every turn. Inflates WITH (more steps = more re-sends). | `bench-agent.sh:155-167` |
| BENCH-004 | H | fixed | `first_turn_input` ignores `cache.read`+`cache.write`. True WITH context = 10336 tokens, recorded as 3424. Undercounts WITH's context cost ~3x. | `bench-agent.sh:155-167` |
| BENCH-005 | C | open | N=3 with 2-2.5x within-cell variance. No significance test, no CI, no effect-size threshold. P(≥2 wins by chance \| no effect) = 50%. | `report-html.mjs:124-157` |
| BENCH-006 | H | fixed | Verdict ignores `input_tokens` entirely — only `tool_calls`, `reads`, `wall_ms`. The value prop (trade tokens for exploration) is invisible to the verdict. | `report-html.mjs:124-157` |
| BENCH-007 | H | open | WITH vs PASSIVE verdict (the most informative comparison) never computed. Only WITH vs WITHOUT. | `report-html.mjs` |
| BENCH-008 | H | fixed | Quality gates are grep-pattern checks, not build/lint/test. s1 passes with a `// check AGENTS.md` comment; s2 with a no-op middleware body. Only s4 runs a real test. | `bench/quality/check-0{1,2,3}.sh` |
| BENCH-009 | H | open | Methodology diverges from ROADMAP claims. N=3 not 5; no temperature 0 flag; rsync/cp not git worktrees; bt-lua not pinned to tag; quality gates are grep not build/lint/test. | `bench-agent.sh:24,26,276` |
| BENCH-010 | H | open | Model is `zai-coding-plan/glm-5.1` (maintainer's employer). No COI disclosure, no second-model cross-check. | `bench-agent.sh:25` |
| BENCH-011 | H | open | Scenario labels in report don't match prompts used. Report calls s1 "CrewExport" but prompt is "Add AGENTS.md check to pmd doctor". s4 has no name. | `report-html.sh:19` vs `bench-agent.sh:75-78` |
| BENCH-012 | M | open | `context_reads` is structurally always zero (agent auto-loads AGENTS.md via system prompt, never explicit read). Dead metric. | `bench-agent.sh:146-151` |
| BENCH-013 | M | open | Dependency install non-deterministic. `npm install \|\| pnpm install \|\| bun install \|\| true` with `2>/dev/null` swallows errors. | `bench-agent.sh:448` |

---

## PLUG — OpenCode Plugin, Hook Adapters

| ID | Sev | Status | Finding | Location |
|----|-----|--------|---------|----------|
| PLUG-001 | C | fixed | Shared `FIFO_TEMP` singleton. Two concurrent reads race on same temp file. Second write clobbers first reader. | `opencode-server.js:30-31,50` |
| PLUG-002 | H | open | All FIFOs collapse to one snapshot. `RENDERED_SNAPSHOT` is a single fixed `.render.md` regardless of which file requested. Multi-pipe setups get cross-wired content. | `opencode-server.js:32,48-50` |
| PLUG-003 | H | fixed | `cleanupFifoTemp()` deletes temp mid-read; `rmdirSync` removes dir on first `afterHandler`. Subsequent reads write into non-existent dir, fail silently. | `opencode-server.js:60-63,461` |
| PLUG-004 | H | open | 10s sync `execFileSync` fallback on read path when `.render.md` missing. Degraded `pmd` stalls agent full 10s. | `opencode-server.js:52-54` |
| PLUG-005 | H | fixed | Active injection has up to ~25s sync blocking worst-case on `tool.execute.before` (10s join + 5s refresh + 5s inject + 5s render fallback). Agent frozen. | `opencode-server.js:395-427` |
| PLUG-006 | H | open | No OpenCode protocol-version handshake. Depends on `experimental.chat.system.transform` event name. Silent failure if renamed — no warning, no fallback. | `opencode-server.js:557-569` |
| PLUG-007 | H | open | 1,534 lines of untyped, unlinted JS outside build pipeline. `eslint.config.js` ignores `src/plugins/`. No knip coverage. Drifts freely. Duplicates TS core logic. | `eslint.config.js:23` |
| PLUG-008 | M | open | `process.cwd()` in server plugin vs `import.meta.url` in TUI plugin. Server reads wrong project's snapshot when launched from non-root cwd. | `opencode-server.js:16,32` vs `opencode-tui.js:13` |
| PLUG-009 | M | fixed | Heartbeat `setInterval` at import with no `unref()`. Keeps Node event loop alive, can block OpenCode process exit. | `opencode-server.js:555` |
| PLUG-010 | M | fixed | Silent `try {} catch {}` swallows config/load errors. `loadConfig` parse failure silently defaults to `delivery:"passive"`. User thinks active, plugin disagrees, no warning. | `opencode-server.js:19-25` |
| PLUG-011 | M | open | TUI does heavy sync I/O every 2s (readdir + N readFileSync + JSON.parse for crew sessions). No mtime short-circuit. Memos recompute on every tick regardless of file changes. | `opencode-tui.js:182-196,619-641` |
| PLUG-012 | M | open | Gemini lacks sub-agent crew support (no SubagentStart/Stop equivalent). Gemini sub-agents won't auto-join crew as workers. | `gemini-hooks.ts:7-12` |

---

## SEC — Relay, Crew, Threat Model, Permissions

| ID | Sev | Status | Finding | Location |
|----|-----|--------|---------|----------|
| SEC-001 | C | fixed | README Quick Start omits the cloned-repo RCE warning. `pmd start` in a cloned repo with committed `.pipemd/config.yml` + `scripts/evil.sh` = RCE on first render. `SECURITY.md` flags it but README doesn't. | `README.md:31-44`, `SECURITY.md:20-31` |
| SEC-002 | H | fixed | Prompt injection via context blocks absent from threat model. Block data from `/blocks` (any localhost caller) and `/sync` (any peer) ends up in agent context. `SECURITY.md` never lists block data as a trust boundary. | `SECURITY.md` (entire), `relay.ts:310-334` |
| SEC-003 | H | fixed | `.pipemd/crew/` is mode 775, session files 664. `SECURITY.md:82-85` claims 0o700. Zero `chmod` calls in crew/fs-utils/paths. Every local user can read all crew sessions and forge new ones. | `crew.ts:58`, `fs-utils.ts:4-15` |
| SEC-004 | H | fixed | `/sync` peer impersonation. `SyncMessage.hostname` is attacker-controlled. Malicious peer with token can claim any hostname, overwrite a third peer's sessions. | `protocol.ts:39-42`, `relay.ts:269` |
| SEC-005 | H | fixed | `/sync` returns ALL groups to any peer, not just requested. Cross-group exfiltration on a multi-project relay. | `relay.ts:272-281` |
| SEC-006 | H | fixed | Windows: identity derived from unauthenticated `.pipemd/crew/${PMD_SESSION}.json` read. `PMD_SESSION=../../../etc/foo` is path traversal. No sanitization. | `crew-process.ts:98-108` |
| SEC-007 | H | open | Localhost-only ≠ user-only. `/crew` and `/blocks` check `isLocalhost` but not UID. Any local user can inject sessions or prompt-injection payloads. Needs SO_PEERCRED or Unix socket. | `relay.ts:225,310,336` |
| SEC-008 | M | fixed | `relay.token` and `peers.json` created world-readable. `SECURITY.md:111` claims "enforced on creation" — false; only relay's read path chmods. | `link.ts:60-63,76-79` |
| SEC-009 | M | open | Coordinator carve-out: dead coordinator with one live worker kept alive indefinitely. Soft-DoS via false conflict warnings. No absolute max age bound. | `crew.ts:149-154` |
| SEC-010 | M | open | README "ephemeral / 15s / in-memory" claim false on daemon side. Sessions persist as JSON under `.pipemd/crew/`, TTL is 90s+30s reap lag, not 15s. | `README.md:406` vs `crew.ts:43,77-82` |
| SEC-011 | M | open | Container PID namespace mismatch. Host relay + container daemon = PIDs can't match across namespaces. Docker-federation identity resolution broken. | `crew-process.ts:93-135` |
| SEC-012 | M | open | `pmd init` "shows every command and requires confirmation" is false. Interactive shows labels + token estimates, not shell commands. `--headless`/`--yes` skip all prompts. | `init.ts:167-583`, `SECURITY.md:28` |
| SEC-013 | M | fixed | `resolveFileContent` reads arbitrary paths. Guard is at CLI boundary (`realpathSync` + `startsWith`), not in the resolver. Any future hook bypassing CLI gets arbitrary file read. | `injection-engine.ts:650-663` |
| SEC-014 | L | fixed | Full `process.env` passed through to spawned custom commands. Leaks daemon's entire env (PATH, HOME, secrets) into user scripts. | `injection-engine.ts:78,821,840` |

---

## STRAT — Strategy, Tests, Claims, Docs

| ID | Sev | Status | Finding | Location |
|----|-----|--------|---------|----------|
| STRAT-001 | C | open | Layer 2 CI ratchet still "planned." No token/latency/accuracy gate in CI. Nothing prevents shipping empty, broken, or 10x-too-large blocks. Every non-earning block silently degrades agent performance. | `ROADMAP.md:175` |
| STRAT-002 | C | open | Layer 3 retrospectives show agents say blocks are mostly noise. "type-check was a dead error — pure noise"; "exports is outright broken"; "the crew block was catastrophic." 18 blocks shipped, agents say 3-4 useful. ~80% waste rate. | `bench/results/retrospectives/` |
| STRAT-003 | C | fixed | No end-to-end FIFO test in `test:unit`. The claimed delivery moat has zero TS-level coverage. Grep for `serveContextPipe`/`mkfifo` returns nothing. | `tests/` |
| STRAT-004 | C | fixed | `e2e.sh` Test 7 (FIFO read) SKIPs on timeout instead of FAILing. Daemon breaks FIFO serving → suite still "passes." | `e2e.sh:192-194` |
| STRAT-005 | C | fixed | No fuzz test for `reverseInject`. Write-back parser is a single regex. Corrupted `<!-- /pmd -->` from agent silently corrupts `template.md`. Only 7 happy-path tests. | `injector.ts:24,157`, `test-reverse-inject.ts` |
| STRAT-006 | H | open | "Sub-ms" / "sub-5ms" moat claim unmeasured anywhere. No latency benchmark exists. Layer 2 is "still planned." Marketing without measurement. | `ROADMAP.md:9,11`, `CONTRIBUTING.md:85` |
| STRAT-007 | H | fixed | `crew-todos` resolver still registered despite ROADMAP Phase 0 claiming it was killed. Only producer is OpenCode plugin. Dead for Claude/Cursor/Gemini/Aider. | `injection-engine.ts:140-154,668` |
| STRAT-008 | H | fixed | `last-read:` cache reader still present despite ROADMAP claiming killed. Only producer is OpenCode plugin. Dead for everyone else. | `injection-engine.ts:173` |
| STRAT-009 | H | fixed | `pmd validate` command exists but is undocumented in README command table. Does same thing as `file-errors` resolver. Duplicated surface. | `validate.ts:1-48` |
| STRAT-010 | H | open | "Works with Claude \| Gemini \| OpenCode \| Cursor \| Aider" overstated. Layer 3 only tests GLM-5.1/OpenCode. 4 of 6 agents never exercised by any automated test or bench. | `README.md:178` |
| STRAT-011 | H | open | Crew hooks not installed on maintainers' own Claude Code agents. 5 passive agents in crew block. Signals low confidence in own UX. | `.pipemd/crew/`, crew block |
| STRAT-012 | H | open | FIFO workaround plugin failing in dogfooding. `.plugin-errors.log` has 9+ ETIMEDOUT entries. The headline "moat" feature is unstable on the reference setup. | `.pipemd/.plugin-errors.log` |
| STRAT-013 | M | open | "41 block types" claim is actually 43. ROADMAP silently excludes `repomap` and `git-context`. | `ROADMAP.md:84`, `constants.ts:75-145` |
| STRAT-014 | M | fixed | `daemon.log` is 34MB with no rotation. Real ops bug. | `logger.ts` |

---

## Fix Priority

Ordered by impact on the product-quality bar defined in `.pipemd/base.md`
Principle 1 ("single-machine flawless"). These are the findings that block
the "flawless" gate.

### Must-fix before "flawless" (Critical + correctness-critical High)

1. **CORE-001** — per-resolver timeout via `Promise.race`/`AbortController`
2. **CORE-005** — dedup per-source TTL (stop starving agents)
3. **CORE-004** — write-back buffer cap (stop OOM vector)
4. **STRAT-003** — FIFO end-to-end test in `test:unit`
5. **STRAT-004** — e2e.sh Test 7 FAIL on timeout, not SKIP
6. **STRAT-005** — fuzz `reverseInject`
7. **SEC-003** — chmod crew dir + session files to 0o700/0o600
8. **SEC-001** — refuse `pmd start` on unblessed config; README RCE warning
9. **SEC-002** — prompt-injection trust boundary in SECURITY.md + delimiter framing
10. **STRAT-001** — Layer 2 CI ratchet (token/latency/accuracy gates)

### Must-fix before benchmark credibility

11. **BENCH-001** — decontaminate WITHOUT condition
12. **BENCH-002** — decontaminate PASSIVE condition
13. **BENCH-003** — fix token accounting (don't sum per-step; include cache.read)
14. **BENCH-006** — include input_tokens in verdict
15. **BENCH-008** — real quality gates (build/lint/test, not grep)

### Must-fix before plugin reliability

16. **PLUG-001** — per-call UUID temp files for FIFO redirect
17. **PLUG-002** — per-FIFO rendered snapshots
18. **PLUG-003** — remove broken `cleanupFifoTemp`
19. **PLUG-005** — async inject (replace `execFileSync` with cached `execFile`)
20. **PLUG-007** — lint + typecheck plugins
