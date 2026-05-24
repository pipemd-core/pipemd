import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  isSessionStale,
  findConflicts,
  toRepoRelative,
  generateSessionId,
  listSessions,
  readSession,
  writeSessionAtomic,
  deleteSession,
  PID_GRACE_MS,
  DEFAULT_STALE_MS,
} from "../src/core/crew.js"
import type { CrewSession } from "../src/core/crew.js"

let tmpDir: string;
let origCwd: string;

function makeSession(overrides: Partial<CrewSession> = {}): CrewSession {
  return {
    schema: 1,
    id: "cr_test123",
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
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-crew-test-"));
  fs.mkdirSync(path.join(tmpDir, ".pipemd", "crew"), { recursive: true });
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("isSessionStale", () => {
  it("fresh session is not stale", () => {
    const s = makeSession({ lastHeartbeat: new Date().toISOString() })
    assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 0), false)
  })

  it("stale heartbeat IS stale", () => {
    const old = Date.now() - DEFAULT_STALE_MS - 10_000
    const s = makeSession({ lastHeartbeat: new Date(old).toISOString() })
    assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 0), true)
  })

  it("stale heartbeat but coordinator with live workers is NOT stale", () => {
    const old = Date.now() - DEFAULT_STALE_MS - 10_000
    const s = makeSession({ lastHeartbeat: new Date(old).toISOString(), role: "coordinator" })
    assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 2), false)
  })

  it("stale heartbeat worker with live workers IS still stale (not coordinator)", () => {
    const old = Date.now() - DEFAULT_STALE_MS - 10_000
    const s = makeSession({ lastHeartbeat: new Date(old).toISOString(), role: "worker" })
    assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 2), true)
  })

  it("dead PID + heartbeat > PID_GRACE_MS IS stale", () => {
    const old = Date.now() - PID_GRACE_MS - 5_000
    const s = makeSession({ lastHeartbeat: new Date(old).toISOString(), pid: 9999999 })
    assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 0), true)
  })

  it("dead PID + heartbeat < PID_GRACE_MS is NOT stale", () => {
    const recent = Date.now() - PID_GRACE_MS + 5_000
    const s = makeSession({ lastHeartbeat: new Date(recent).toISOString(), pid: 9999999 })
    assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 0), false)
  })

  it("NaN heartbeat is treated as stale (Infinity age)", () => {
    const s = makeSession({ lastHeartbeat: "not-a-date" })
    assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 0), true)
  })

  it("NaN heartbeat coordinator with live workers is NOT stale", () => {
    const s = makeSession({ lastHeartbeat: "not-a-date", role: "coordinator" })
    assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 1), false)
  })
})

describe("findConflicts", () => {
  it("no conflicts when each file is claimed by at most one session", () => {
    const sessions = [
      makeSession({ id: "cr_a", claimedFiles: [{ path: "src/a.ts", claimedAt: "" }] }),
      makeSession({ id: "cr_b", claimedFiles: [{ path: "src/b.ts", claimedAt: "" }] }),
    ]
    assert.deepEqual(findConflicts(sessions), [])
  })

  it("conflict detected when two sessions claim the same file", () => {
    const sessions = [
      makeSession({ id: "cr_a", claimedFiles: [{ path: "src/shared.ts", claimedAt: "" }] }),
      makeSession({ id: "cr_b", claimedFiles: [{ path: "src/shared.ts", claimedAt: "" }] }),
    ]
    const conflicts = findConflicts(sessions)
    assert.equal(conflicts.length, 1)
    assert.equal(conflicts[0].path, "src/shared.ts")
    assert.ok(conflicts[0].sessionIds.includes("cr_a"))
    assert.ok(conflicts[0].sessionIds.includes("cr_b"))
  })

  it("multiple conflicts detected", () => {
    const sessions = [
      makeSession({ id: "cr_a", claimedFiles: [{ path: "src/x.ts", claimedAt: "" }, { path: "src/y.ts", claimedAt: "" }] }),
      makeSession({ id: "cr_b", claimedFiles: [{ path: "src/x.ts", claimedAt: "" }, { path: "src/y.ts", claimedAt: "" }] }),
    ]
    const conflicts = findConflicts(sessions)
    assert.equal(conflicts.length, 2)
    const paths = conflicts.map((c) => c.path).sort()
    assert.deepEqual(paths, ["src/x.ts", "src/y.ts"])
  })

  it("empty sessions list = no conflicts", () => {
    assert.deepEqual(findConflicts([]), [])
  })

  it("sessions with empty claimedFiles = no conflicts", () => {
    const sessions = [makeSession({ id: "cr_a" }), makeSession({ id: "cr_b" })]
    assert.deepEqual(findConflicts(sessions), [])
  })
})

describe("toRepoRelative", () => {
  it("absolute path within cwd returns relative", () => {
    const abs = path.join(process.cwd(), "src", "index.ts")
    assert.equal(toRepoRelative(abs), "src/index.ts")
  })

  it("relative path returns as-is (forward slashes)", () => {
    assert.equal(toRepoRelative("src/index.ts"), "src/index.ts")
  })
})

describe("generateSessionId", () => {
  it("returns string starting with cr_", () => {
    const id = generateSessionId()
    assert.ok(id.startsWith("cr_"), `Expected cr_ prefix, got: ${id}`)
  })

  it("returns different values on each call", () => {
    const a = generateSessionId()
    const b = generateSessionId()
    assert.notEqual(a, b)
  })

  it("id has expected length (cr_ + 12 hex chars)", () => {
    const id = generateSessionId()
    assert.ok(/^cr_[0-9a-f]{12}$/.test(id), `Unexpected format: ${id}`)
  })
})

describe("filesystem (writeSessionAtomic / readSession / deleteSession / listSessions)", () => {
  it("write then read round-trip", () => {
    const id = "cr_" + Math.random().toString(36).slice(2, 10)
    const s = makeSession({ id, lastHeartbeat: new Date().toISOString() })
    writeSessionAtomic(s)
    const read = readSession(id)
    assert.ok(read, "readSession should return a session")
    assert.equal(read!.id, id)
    assert.equal(read!.role, "coordinator")
    assert.equal(read!.harness, "TestHarness")
  })

  it("read non-existent returns null", () => {
    assert.equal(readSession("cr_nonexistent_00000000"), null)
  })

  it("delete removes the file", () => {
    const id = "cr_" + Math.random().toString(36).slice(2, 10)
    writeSessionAtomic(makeSession({ id }))
    assert.ok(readSession(id), "should exist before delete")
    deleteSession(id)
    assert.equal(readSession(id), null, "should be gone after delete")
  })

  it("delete non-existent does not throw", () => {
    assert.doesNotThrow(() => deleteSession("cr_no_such_session"))
  })

  it("listSessions returns sessions from JSON files", () => {
    const id1 = "cr_" + Math.random().toString(36).slice(2, 10)
    const id2 = "cr_" + Math.random().toString(36).slice(2, 10)
    writeSessionAtomic(makeSession({ id: id1 }))
    writeSessionAtomic(makeSession({ id: id2 }))
    const ids = listSessions().map((s) => s.id)
    assert.ok(ids.includes(id1), `should include ${id1}`)
    assert.ok(ids.includes(id2), `should include ${id2}`)
  })

  it("listSessions skips malformed JSON files", () => {
    const badId = "cr_bad_" + Math.random().toString(36).slice(2, 10)
    const badPath = path.join(".pipemd", "crew", `${badId}.json`)
    fs.writeFileSync(badPath, "{{not json}}")
    const ids = listSessions().map((s) => s.id)
    assert.ok(!ids.includes(badId), "should skip malformed file")
    try { fs.unlinkSync(badPath) } catch {}
  })
})
