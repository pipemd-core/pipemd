import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

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
const { invalidateSessionListCache } = await import("../src/core/crew.js")
const { clearMemCache } = await import("../src/core/dedup.js")

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
  invalidateSessionListCache()
}

function clearCrew() {
  const dir = path.join(tmpDir, ".pipemd", "crew")
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".json")) fs.unlinkSync(path.join(dir, f))
  }
  invalidateSessionListCache()
}

function clearDedup() {
  const dir = path.join(tmpDir, ".pipemd", "cache", "injected")
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".json")) fs.unlinkSync(path.join(dir, f))
  }
  clearMemCache()
}

describe("before-read", () => {
  it("with no sessions returns empty (nothing to report)", async () => {
    clearCrew()
    clearDedup()
    const payloads = await resolveInjections("before-read", undefined, "sess-1")
    assert.equal(payloads.length, 0)
  })

  it("with a single session and no conflicts returns empty (solo dev)", async () => {
    clearCrew()
    clearDedup()
    writeCrewSession(makeSession({ id: "cr_alpha", harness: "AlphaAgent" }))
    const payloads = await resolveInjections("before-read", undefined, "sess-2")
    assert.equal(payloads.length, 0)
  })

  it("with multiple sessions shows crew status", async () => {
    clearCrew()
    clearDedup()
    writeCrewSession(makeSession({ id: "cr_alpha", harness: "AlphaAgent" }))
    writeCrewSession(makeSession({ id: "cr_beta", harness: "BetaAgent", pid: 88888 }))
    const payloads = await resolveInjections("before-read", undefined, "sess-2b")
    assert.equal(payloads.length, 1)
    assert.ok(payloads[0].content.includes("2 session(s)"))
    assert.ok(payloads[0].content.includes("AlphaAgent"))
    assert.ok(payloads[0].content.includes("cr_alpha"))
  })

  it("with remote session shows crew status even with 1 local", async () => {
    clearCrew()
    clearDedup()
    writeCrewSession(makeSession({ id: "cr_local", harness: "LocalAgent" }))
    const { setRemoteSessions, clearRemoteSessions, invalidateSessionListCache } = await import("../src/core/crew.js")
    setRemoteSessions([Object.assign(makeSession({ id: "cr_remote", harness: "RemoteAgent" }), { _remote: true, _origin: "other-host" })])
    invalidateSessionListCache()
    const payloads = await resolveInjections("before-read", undefined, "sess-2c")
    assert.equal(payloads.length, 1)
    assert.ok(payloads[0].content.includes("from other-host"))
    clearRemoteSessions()
    invalidateSessionListCache()
  })
})

describe("before-edit", () => {
  it("without targetFile skips target-file scoped rules", async () => {
    clearCrew()
    clearDedup()
    const payloads = await resolveInjections("before-edit", undefined, "sess-3")
    assert.equal(payloads.length, 0)
  })

  it("with targetFile and no claims returns empty (nothing to report)", async () => {
    clearCrew()
    clearDedup()
    const payloads = await resolveInjections("before-edit", "src/foo.ts", "sess-4")
    assert.equal(payloads.length, 0)
  })

  it("with claim on target file returns claimed info", async () => {
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
    const payloads = await resolveInjections("before-edit", "src/bar.ts", "sess-5")
    assert.equal(payloads.length, 1)
    assert.ok(payloads[0].content.includes("claimed by"))
    assert.ok(payloads[0].content.includes("ClaimantAgent"))
    assert.ok(payloads[0].content.includes("cr_claimant"))
  })

  it("with conflicting claims shows CONFLICT", async () => {
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
    const payloads = await resolveInjections("before-edit", "src/conflict.ts", "sess-6")
    assert.equal(payloads.length, 1)
    assert.ok(payloads[0].content.includes("CONFLICT"))
  })

  it("on different file than the claim returns empty (unclaimed)", async () => {
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
    const payloads = await resolveInjections("before-edit", "src/unclaimed.ts", "sess-8")
    assert.equal(payloads.length, 0)
  })
})

describe("dedup", () => {
  it("second call with identical content returns empty", async () => {
    clearCrew()
    clearDedup()
    writeCrewSession(makeSession({ id: "cr_dedup1", harness: "DedupAgent1" }))
    writeCrewSession(makeSession({ id: "cr_dedup2", harness: "DedupAgent2", pid: 88888 }))
    const first = await resolveInjections("before-read", undefined, "sess-dedup")
    assert.equal(first.length, 1)
    const second = await resolveInjections("before-read", undefined, "sess-dedup")
    assert.equal(second.length, 0)
  })

  it("changed content after state change returns new payload", async () => {
    clearCrew()
    clearDedup()
    writeCrewSession(makeSession({ id: "cr_old", harness: "OldAgent" }))
    writeCrewSession(makeSession({ id: "cr_dedup3", harness: "DedupAgent3", pid: 77777 }))
    const first = await resolveInjections("before-read", undefined, "sess-dedup2")
    assert.equal(first.length, 1)
    assert.ok(first[0].content.includes("OldAgent"))
    writeCrewSession(makeSession({ id: "cr_new", harness: "NewAgent" }))
    const second = await resolveInjections("before-read", undefined, "sess-dedup2")
    assert.equal(second.length, 1)
    assert.ok(second[0].content.includes("NewAgent"))
  })

  it("different session ids have independent dedup state", async () => {
    clearCrew()
    clearDedup()
    writeCrewSession(makeSession({ id: "cr_ind", harness: "IndAgent" }))
    writeCrewSession(makeSession({ id: "cr_ind2", harness: "IndAgent2", pid: 66666 }))
    const first = await resolveInjections("before-read", undefined, "sess-ind-a")
    assert.equal(first.length, 1)
    const second = await resolveInjections("before-read", undefined, "sess-ind-b")
    assert.equal(second.length, 1)
  })
})

describe("misc", () => {
  it("trigger with no configured rules returns empty", async () => {
    clearCrew()
    clearDedup()
    const payloads = await resolveInjections("on-idle", undefined, "sess-7")
    assert.equal(payloads.length, 0)
  })

  it("payload hash is 16 hex characters", async () => {
    clearCrew()
    clearDedup()
    writeCrewSession(makeSession({ id: "cr_hash", harness: "HashAgent" }))
    writeCrewSession(makeSession({ id: "cr_hash2", harness: "HashAgent2", pid: 55555 }))
    const payloads = await resolveInjections("before-read", undefined, "sess-hash")
    assert.equal(payloads.length, 1)
    assert.ok(
      /^[0-9a-f]{16}$/.test(payloads[0].hash),
      `expected 16-char hex hash, got: ${payloads[0].hash}`,
    )
  })

  it("max-lines truncation applied when output exceeds limit", async () => {
    clearCrew()
    clearDedup()
    for (let i = 0; i < 10; i++) {
      writeCrewSession(
        makeSession({ id: `cr_many_${i}`, harness: `Agent${i}`, pid: 10000 + i }),
      )
    }
    const payloads = await resolveInjections("before-read", undefined, "sess-trunc")
    assert.equal(payloads.length, 1)
    const lines = payloads[0].content.split("\n")
    assert.ok(lines.length <= 4, `expected ≤4 lines, got ${lines.length}`)
    assert.ok(payloads[0].content.includes("... (+"), "should contain truncation marker")
  })
})

describe("test-failures resolver", () => {
  it("returns cached failure data from cache", async () => {
    clearDedup()
    const { writeCache } = await import("../src/core/cache.js")
    writeCache("test-failures", "2 test(s) failed:\n• not ok 1 - foo\n• not ok 2 - bar", 60000)
    const { RESOLVERS } = await import("../src/core/injection-engine.ts")
    const resolve = (RESOLVERS as Record<string, any>)["test-failures"]
    const result = await resolve({ trigger: "on-start", config: { delivery: "active", rules: {} } })
    assert.ok(result.includes("2 test(s) failed"))
    assert.ok(result.includes("not ok 1 - foo"))
    const { invalidate } = await import("../src/core/cache.js")
    invalidate("test-failures")
  })

  it("returns empty when cache has all-pass marker", async () => {
    clearDedup()
    const { writeCache } = await import("../src/core/cache.js")
    writeCache("test-failures", "__all_pass__", 60000)
    const { RESOLVERS } = await import("../src/core/injection-engine.ts")
    const resolve = (RESOLVERS as Record<string, any>)["test-failures"]
    const result = await resolve({ trigger: "on-start", config: { delivery: "active", rules: {} } })
    assert.equal(result, "")
    const { invalidate } = await import("../src/core/cache.js")
    invalidate("test-failures")
  })

  it("returns empty when cache entry has expired", async () => {
    clearDedup()
    const { writeCache, readCache } = await import("../src/core/cache.js")
    const entry = writeCache("test-failures", "1 test(s) failed:\n• not ok 1 - expired", 0)
    entry.timestamp = Date.now() - 1000
    fs.writeFileSync(
      path.join(tmpDir, ".pipemd", "cache", "sources", "test-failures.json"),
      JSON.stringify(entry),
    )
    const cached = readCache("test-failures")
    assert.equal(cached, null)
    const { invalidate } = await import("../src/core/cache.js")
    invalidate("test-failures")
  })

  it("returns empty when no package.json exists", async () => {
    clearDedup()
    const { invalidate } = await import("../src/core/cache.js")
    invalidate("test-failures")
    const { RESOLVERS } = await import("../src/core/injection-engine.ts")
    const resolve = (RESOLVERS as Record<string, any>)["test-failures"]
    const result = await resolve({ trigger: "on-start", config: { delivery: "active", rules: {} } })
    assert.equal(result, "")
  })
})

describe("context-rules", () => {
  it("returns empty when no context-files configured", async () => {
    clearCrew()
    clearDedup()
    const payloads = await resolveInjections("on-idle", undefined, "sess-cr1")
    assert.equal(payloads.length, 0)
  })

  it("returns file content when glob matches existing files", async () => {
    clearCrew()
    clearDedup()
    fs.writeFileSync(path.join(tmpDir, "hello.txt"), "line1\nline2\nline3\n")
    fs.writeFileSync(
      path.join(tmpDir, ".pipemd", "injection.yml"),
      `delivery: expert
rules:
  before-read:
    - source: context-rules
      scope: global
      max-lines: 50
context-files:
  - glob: "hello.txt"
    trigger: before-read
    max-lines: 10
`,
    )
    const payloads = await resolveInjections("before-read", undefined, "sess-cr2")
    assert.equal(payloads.length, 1)
    assert.ok(payloads[0].content.includes("=== hello.txt ==="))
    assert.ok(payloads[0].content.includes("line1"))
    assert.ok(payloads[0].content.includes("line3"))
  })

  it("returns empty when glob matches nothing", async () => {
    clearCrew()
    clearDedup()
    fs.writeFileSync(
      path.join(tmpDir, ".pipemd", "injection.yml"),
      `delivery: expert
rules:
  before-read:
    - source: context-rules
      scope: global
context-files:
  - glob: "nonexistent/**/*.xyz"
    trigger: before-read
`,
    )
    const payloads = await resolveInjections("before-read", undefined, "sess-cr3")
    assert.equal(payloads.length, 0)
  })

  it("respects max-lines truncation", async () => {
    clearCrew()
    clearDedup()
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
    fs.writeFileSync(path.join(tmpDir, "long.txt"), lines.join("\n") + "\n")
    fs.writeFileSync(
      path.join(tmpDir, ".pipemd", "injection.yml"),
      `delivery: expert
rules:
  before-read:
    - source: context-rules
      scope: global
context-files:
  - glob: "long.txt"
    trigger: before-read
    max-lines: 5
`,
    )
    const payloads = await resolveInjections("before-read", undefined, "sess-cr4")
    assert.equal(payloads.length, 1)
    assert.ok(payloads[0].content.includes("=== long.txt ==="))
    assert.ok(payloads[0].content.includes("line5"))
    assert.ok(!payloads[0].content.includes("line6"))
    assert.ok(payloads[0].content.includes("... (+"))
  })
})

after(() => {
  process.chdir(origDir)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
