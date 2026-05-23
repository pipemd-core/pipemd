import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
    passed++
  } catch (err: any) {
    console.log(`  \x1b[31m✖\x1b[0m ${name}`)
    console.log(`    ${err.message}`)
    if (err.stack) {
      const lines = err.stack.split("\n").slice(1, 4)
      for (const l of lines) console.log(`    ${l.trim()}`)
    }
    failed++
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-inject-test-"))

fs.mkdirSync(path.join(tmpDir, ".pipemd"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "crew"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "injected"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "sources"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "validation"), { recursive: true })

fs.writeFileSync(
  path.join(tmpDir, ".pipemd", "injection.yml"),
  `delivery: active
rules:
  before-read:
    - source: crew-status
      scope: global
      max-lines: 3
  before-edit:
    - source: crew-locks
      scope: target-file
`,
)

const origDir = process.cwd()
process.chdir(tmpDir)

const { resolveInjections } = await import("../src/core/injection-engine.js")

function makeSession(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    schema: 1,
    id: overrides.id || "cr_test",
    role: overrides.role || "coordinator",
    harness: overrides.harness || "TestHarness",
    label: undefined,
    pid: overrides.pid || 99999,
    ppid: 1,
    coordinatorId: null,
    claimedFiles: overrides.claimedFiles || [],
    note: undefined,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    cwd: tmpDir,
  }
}

function writeCrewSession(session: Record<string, any>) {
  fs.writeFileSync(
    path.join(tmpDir, ".pipemd", "crew", `${session.id}.json`),
    JSON.stringify(session, null, 2),
  )
}

function clearCrew() {
  const dir = path.join(tmpDir, ".pipemd", "crew")
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".json")) fs.unlinkSync(path.join(dir, f))
  }
}

function clearDedup() {
  const dir = path.join(tmpDir, ".pipemd", "cache", "injected")
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".json")) fs.unlinkSync(path.join(dir, f))
  }
}

console.log("\x1b[1;33m═══ Injection Engine Unit Tests ═══\x1b[0m\n")

test("before-read with no sessions returns crew-status payload", () => {
  clearCrew()
  clearDedup()
  const payloads = resolveInjections("before-read", undefined, "sess-1")
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0].source, "crew-status")
  assert.ok(payloads[0].content.includes("no active sessions"))
  assert.equal(payloads[0].trigger, "before-read")
  assert.equal(payloads[0].scope, "global")
})

test("before-read with a session shows session info", () => {
  clearCrew()
  clearDedup()
  writeCrewSession(makeSession({ id: "cr_alpha", harness: "AlphaAgent" }))
  const payloads = resolveInjections("before-read", undefined, "sess-2")
  assert.equal(payloads.length, 1)
  assert.ok(payloads[0].content.includes("1 session(s)"))
  assert.ok(payloads[0].content.includes("AlphaAgent"))
  assert.ok(payloads[0].content.includes("cr_alpha"))
})

test("before-edit without targetFile skips target-file scoped rules", () => {
  clearCrew()
  clearDedup()
  const payloads = resolveInjections("before-edit", undefined, "sess-3")
  assert.equal(payloads.length, 0)
})

test("before-edit with targetFile and no claims returns unclaimed", () => {
  clearCrew()
  clearDedup()
  const payloads = resolveInjections("before-edit", "src/foo.ts", "sess-4")
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0].source, "crew-locks")
  assert.ok(payloads[0].content.includes("unclaimed"))
  assert.equal(payloads[0].targetFile, "src/foo.ts")
})

test("before-edit with claim on target file returns claimed info", () => {
  clearCrew()
  clearDedup()
  const now = new Date().toISOString()
  writeCrewSession(
    makeSession({
      id: "cr_claimant",
      harness: "ClaimantAgent",
      claimedFiles: [{ path: "src/bar.ts", claimedAt: now }],
    }),
  )
  const payloads = resolveInjections("before-edit", "src/bar.ts", "sess-5")
  assert.equal(payloads.length, 1)
  assert.ok(payloads[0].content.includes("claimed by"))
  assert.ok(payloads[0].content.includes("ClaimantAgent"))
  assert.ok(payloads[0].content.includes("cr_claimant"))
})

test("before-edit with conflicting claims shows CONFLICT", () => {
  clearCrew()
  clearDedup()
  const now = new Date().toISOString()
  writeCrewSession(
    makeSession({
      id: "cr_a",
      harness: "AgentA",
      claimedFiles: [{ path: "src/conflict.ts", claimedAt: now }],
    }),
  )
  writeCrewSession(
    makeSession({
      id: "cr_b",
      harness: "AgentB",
      claimedFiles: [{ path: "src/conflict.ts", claimedAt: now }],
    }),
  )
  const payloads = resolveInjections("before-edit", "src/conflict.ts", "sess-6")
  assert.equal(payloads.length, 1)
  assert.ok(payloads[0].content.includes("CONFLICT"))
})

test("dedup: second call with identical content returns empty", () => {
  clearCrew()
  clearDedup()
  const first = resolveInjections("before-read", undefined, "sess-dedup")
  assert.equal(first.length, 1)
  const second = resolveInjections("before-read", undefined, "sess-dedup")
  assert.equal(second.length, 0)
})

test("dedup: changed content after state change returns new payload", () => {
  clearCrew()
  clearDedup()
  const first = resolveInjections("before-read", undefined, "sess-dedup2")
  assert.equal(first.length, 1)
  assert.ok(first[0].content.includes("no active sessions"))
  writeCrewSession(makeSession({ id: "cr_new", harness: "NewAgent" }))
  const second = resolveInjections("before-read", undefined, "sess-dedup2")
  assert.equal(second.length, 1)
  assert.ok(second[0].content.includes("NewAgent"))
})

test("trigger with no configured rules returns empty", () => {
  clearCrew()
  clearDedup()
  const payloads = resolveInjections("on-idle", undefined, "sess-7")
  assert.equal(payloads.length, 0)
})

test("payload hash is 16 hex characters", () => {
  clearCrew()
  clearDedup()
  const payloads = resolveInjections("before-read", undefined, "sess-hash")
  assert.equal(payloads.length, 1)
  assert.ok(
    /^[0-9a-f]{16}$/.test(payloads[0].hash),
    `expected 16-char hex hash, got: ${payloads[0].hash}`,
  )
})

test("max-lines truncation applied when output exceeds limit", () => {
  clearCrew()
  clearDedup()
  for (let i = 0; i < 10; i++) {
    writeCrewSession(
      makeSession({ id: `cr_many_${i}`, harness: `Agent${i}`, pid: 10000 + i }),
    )
  }
  const payloads = resolveInjections("before-read", undefined, "sess-trunc")
  assert.equal(payloads.length, 1)
  const lines = payloads[0].content.split("\n")
  assert.ok(lines.length <= 4, `expected ≤4 lines, got ${lines.length}`)
  assert.ok(payloads[0].content.includes("... (+"), "should contain truncation marker")
})

test("before-edit on different file than the claim returns unclaimed", () => {
  clearCrew()
  clearDedup()
  const now = new Date().toISOString()
  writeCrewSession(
    makeSession({
      id: "cr_other",
      harness: "OtherAgent",
      claimedFiles: [{ path: "src/claimed.ts", claimedAt: now }],
    }),
  )
  const payloads = resolveInjections("before-edit", "src/unclaimed.ts", "sess-8")
  assert.equal(payloads.length, 1)
  assert.ok(payloads[0].content.includes("unclaimed"))
})

test("different session ids have independent dedup state", () => {
  clearCrew()
  clearDedup()
  const first = resolveInjections("before-read", undefined, "sess-ind-a")
  assert.equal(first.length, 1)
  const second = resolveInjections("before-read", undefined, "sess-ind-b")
  assert.equal(second.length, 1)
})

process.chdir(origDir)
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log("")
console.log("\x1b[1;33m═══ Results ═══\x1b[0m")
console.log(`  \x1b[32mPASS\x1b[0m: ${passed}`)
console.log(`  \x1b[31mFAIL\x1b[0m: ${failed}`)

if (failed > 0) {
  console.log(`\n\x1b[31m✖ Injection engine tests failed\x1b[0m`)
  process.exit(1)
} else {
  console.log(`\n\x1b[32m✔ All injection engine tests passed\x1b[0m`)
  process.exit(0)
}
