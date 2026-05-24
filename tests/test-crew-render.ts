import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { renderCrewBlock, renderCrewBlockAsync, getStatusJson } from "../src/core/crew-render.js"
import { writeSessionAtomic, deleteSession, invalidateSessionListCache, type CrewSession } from "../src/core/crew.js"

let tmpDir: string
let origCwd: string

function makeSession(overrides: Partial<CrewSession> = {}): CrewSession {
  return {
    schema: 1,
    id: "cr_rendertest" + Math.random().toString(36).slice(2, 8),
    role: "coordinator",
    harness: "TestHarness",
    pid: 9999999,
    ppid: 1,
    coordinatorId: null,
    claimedFiles: [],
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    cwd: "/tmp",
    ...overrides,
  }
}

before(() => {
  origCwd = process.cwd()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-crew-render-test-"))
  fs.mkdirSync(path.join(tmpDir, ".pipemd", "crew"), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true })
  process.chdir(tmpDir)
})

after(() => {
  process.chdir(origCwd)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("renderCrewBlock — empty state", () => {
  it("renders no sessions message when no sessions exist", () => {
    const result = renderCrewBlock({ reap: false })
    assert.ok(result.includes("0 harness(es), 0 active session(s)"))
    assert.ok(result.includes("No active PipeMD crew sessions"))
  })
})

describe("renderCrewBlock — with sessions", () => {
  after(() => {
    for (const f of fs.readdirSync(path.join(tmpDir, ".pipemd", "crew"))) {
      try { fs.unlinkSync(path.join(tmpDir, ".pipemd", "crew", f)) } catch {}
    }
  })

  it("renders a single coordinator session", () => {
    const s = makeSession({ id: "cr_coord1", role: "coordinator", harness: "OpenCode" })
    writeSessionAtomic(s)
    const result = renderCrewBlock({ reap: false })
    assert.ok(result.includes("OpenCode"))
    assert.ok(result.includes("coordinator"))
    assert.ok(result.includes("cr_coord1"))
    deleteSession("cr_coord1")
  })

  it("renders coordinator with claimed files", () => {
    const s = makeSession({
      id: "cr_claimed",
      role: "coordinator",
      claimedFiles: [{ path: "src/index.ts", claimedAt: "" }, { path: "src/util.ts", claimedAt: "" }],
    })
    writeSessionAtomic(s)
    const result = renderCrewBlock({ reap: false })
    assert.ok(result.includes("src/index.ts"))
    assert.ok(result.includes("src/util.ts"))
    assert.ok(result.includes("claimed"))
    deleteSession("cr_claimed")
  })

  it("renders coordinator with a note", () => {
    const s = makeSession({ id: "cr_noted", role: "coordinator", note: "refactoring auth" })
    writeSessionAtomic(s)
    const result = renderCrewBlock({ reap: false })
    assert.ok(result.includes("refactoring auth"))
    deleteSession("cr_noted")
  })

  it("renders workers under their coordinator", () => {
    const coord = makeSession({ id: "cr_wcoord", role: "coordinator" })
    const worker = makeSession({
      id: "cr_wworker",
      role: "worker",
      coordinatorId: "cr_wcoord",
      label: "worker-1",
    })
    writeSessionAtomic(coord)
    writeSessionAtomic(worker)
    const result = renderCrewBlock({ reap: false })
    assert.ok(result.includes("cr_wcoord"))
    assert.ok(result.includes("worker-1"))
    assert.ok(result.includes("└─") || result.includes("├─"))
    deleteSession("cr_wcoord")
    deleteSession("cr_wworker")
  })

  it("renders unattached workers", () => {
    const worker = makeSession({
      id: "cr_unattached",
      role: "worker",
      coordinatorId: null,
      harness: "Claude",
    })
    writeSessionAtomic(worker)
    const result = renderCrewBlock({ reap: false })
    assert.ok(result.includes("Unattached workers"))
    deleteSession("cr_unattached")
  })

  it("renders conflict when two sessions claim the same file", () => {
    const a = makeSession({
      id: "cr_conflict_a",
      role: "coordinator",
      claimedFiles: [{ path: "src/shared.ts", claimedAt: "" }],
    })
    const b = makeSession({
      id: "cr_conflict_b",
      role: "coordinator",
      claimedFiles: [{ path: "src/shared.ts", claimedAt: "" }],
    })
    writeSessionAtomic(a)
    writeSessionAtomic(b)
    const result = renderCrewBlock({ reap: false })
    assert.ok(result.includes("CONFLICT"))
    assert.ok(result.includes("src/shared.ts"))
    deleteSession("cr_conflict_a")
    deleteSession("cr_conflict_b")
  })
})

describe("renderCrewBlock — truncation", () => {
  after(() => {
    for (const f of fs.readdirSync(path.join(tmpDir, ".pipemd", "crew"))) {
      try { fs.unlinkSync(path.join(tmpDir, ".pipemd", "crew", f)) } catch {}
    }
  })

  it("truncates output when maxLines is small", () => {
    for (let i = 0; i < 20; i++) {
      writeSessionAtomic(makeSession({
        id: `cr_trunc_${i}`,
        role: "coordinator",
        harness: `H${i}`,
      }))
    }
    const result = renderCrewBlock({ reap: false, maxLines: 5 })
    assert.ok(result.includes("truncated"))
    for (let i = 0; i < 20; i++) {
      deleteSession(`cr_trunc_${i}`)
    }
  })

  it("does not truncate when maxLines is large enough", () => {
    writeSessionAtomic(makeSession({ id: "cr_notrunc", role: "coordinator" }))
    const result = renderCrewBlock({ reap: false, maxLines: 100 })
    assert.ok(!result.includes("truncated"))
    deleteSession("cr_notrunc")
  })
})

describe("renderCrewBlockAsync", () => {
  after(() => {
    for (const f of fs.readdirSync(path.join(tmpDir, ".pipemd", "crew"))) {
      try { fs.unlinkSync(path.join(tmpDir, ".pipemd", "crew", f)) } catch {}
    }
  })

  it("returns a string (async version)", async () => {
    const result = await renderCrewBlockAsync({ reap: false })
    assert.ok(typeof result === "string")
    assert.ok(result.includes("0 active session(s)") || result.includes("active session"))
  })

  it("renders sessions (async)", async () => {
    const s = makeSession({ id: "cr_async1", role: "coordinator", harness: "AsyncTest" })
    writeSessionAtomic(s)
    const result = await renderCrewBlockAsync({ reap: false })
    assert.ok(result.includes("AsyncTest"))
    deleteSession("cr_async1")
  })
})

describe("getStatusJson", () => {
  after(() => {
    for (const f of fs.readdirSync(path.join(tmpDir, ".pipemd", "crew"))) {
      try { fs.unlinkSync(path.join(tmpDir, ".pipemd", "crew", f)) } catch {}
    }
  })

  it("returns empty sessions when none exist", () => {
    for (const f of fs.readdirSync(path.join(tmpDir, ".pipemd", "crew"))) {
      try { fs.unlinkSync(path.join(tmpDir, ".pipemd", "crew", f)) } catch {}
    }
    invalidateSessionListCache()
    const status = getStatusJson()
    assert.equal(status.sessionCount, 0)
    assert.equal(status.harnessCount, 0)
    assert.deepEqual(status.sessions, [])
    assert.deepEqual(status.conflicts, [])
  })

  it("returns session data for active sessions", () => {
    const s = makeSession({
      id: "cr_json1",
      role: "coordinator",
      harness: "JsonTest",
      claimedFiles: [{ path: "src/a.ts", claimedAt: "" }],
    })
    writeSessionAtomic(s)
    const status = getStatusJson()
    assert.equal(status.sessionCount, 1)
    assert.equal(status.harnessCount, 1)
    assert.equal(status.sessions[0].id, "cr_json1")
    assert.deepEqual(status.sessions[0].claimedFiles, ["src/a.ts"])
    deleteSession("cr_json1")
  })

  it("reports conflicts", () => {
    const a = makeSession({ id: "cr_jca", claimedFiles: [{ path: "src/x.ts", claimedAt: "" }] })
    const b = makeSession({ id: "cr_jcb", claimedFiles: [{ path: "src/x.ts", claimedAt: "" }] })
    writeSessionAtomic(a)
    writeSessionAtomic(b)
    const status = getStatusJson()
    assert.equal(status.conflicts.length, 1)
    assert.equal(status.conflicts[0].path, "src/x.ts")
    deleteSession("cr_jca")
    deleteSession("cr_jcb")
  })

  it("counts multiple harnesses", () => {
    writeSessionAtomic(makeSession({ id: "cr_h1", harness: "OpenCode" }))
    writeSessionAtomic(makeSession({ id: "cr_h2", harness: "Claude" }))
    const status = getStatusJson()
    assert.equal(status.harnessCount, 2)
    assert.equal(status.sessionCount, 2)
    deleteSession("cr_h1")
    deleteSession("cr_h2")
  })

  it("includes session note", () => {
    writeSessionAtomic(makeSession({ id: "cr_note", note: "working on auth" }))
    const status = getStatusJson()
    assert.equal(status.sessions[0].note, "working on auth")
    deleteSession("cr_note")
  })
})
