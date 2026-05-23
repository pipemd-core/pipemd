import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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
} from '../src/core/crew.js'
import type { CrewSession } from '../src/core/crew.js'

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
    failed++
  }
}

function makeSession(overrides: Partial<CrewSession> = {}): CrewSession {
  return {
    schema: 1,
    id: 'cr_test123',
    role: 'coordinator',
    harness: 'TestHarness',
    pid: 9999999,
    ppid: 1,
    coordinatorId: null,
    claimedFiles: [],
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    cwd: '/tmp',
    ...overrides,
  }
}

const TEST_IDS: string[] = []
function testId(): string {
  const id = 'cr_test_' + Math.random().toString(36).slice(2, 10)
  TEST_IDS.push(id)
  return id
}

function cleanupTestSessions() {
  for (const id of TEST_IDS) {
    try { fs.unlinkSync(path.join('.pipemd', 'crew', `${id}.json`)) } catch {}
  }
}

console.log('\x1b[1;33m═══ crew.ts Unit Tests ═══\x1b[0m\n')

// ---------------------------------------------------------------------------
// isSessionStale
// ---------------------------------------------------------------------------

console.log('isSessionStale')

test('fresh session is not stale', () => {
  const s = makeSession({ lastHeartbeat: new Date().toISOString() })
  assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 0), false)
})

test('stale heartbeat IS stale', () => {
  const old = Date.now() - DEFAULT_STALE_MS - 10_000
  const s = makeSession({ lastHeartbeat: new Date(old).toISOString() })
  assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 0), true)
})

test('stale heartbeat but coordinator with live workers is NOT stale', () => {
  const old = Date.now() - DEFAULT_STALE_MS - 10_000
  const s = makeSession({ lastHeartbeat: new Date(old).toISOString(), role: 'coordinator' })
  assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 2), false)
})

test('stale heartbeat worker with live workers IS still stale (not coordinator)', () => {
  const old = Date.now() - DEFAULT_STALE_MS - 10_000
  const s = makeSession({ lastHeartbeat: new Date(old).toISOString(), role: 'worker' })
  assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 2), true)
})

test('dead PID + heartbeat > PID_GRACE_MS IS stale', () => {
  const old = Date.now() - PID_GRACE_MS - 5_000
  const s = makeSession({ lastHeartbeat: new Date(old).toISOString(), pid: 9999999 })
  assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 0), true)
})

test('dead PID + heartbeat < PID_GRACE_MS is NOT stale', () => {
  const recent = Date.now() - PID_GRACE_MS + 5_000
  const s = makeSession({ lastHeartbeat: new Date(recent).toISOString(), pid: 9999999 })
  assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 0), false)
})

test('NaN heartbeat is treated as stale (Infinity age)', () => {
  const s = makeSession({ lastHeartbeat: 'not-a-date' })
  assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 0), true)
})

test('NaN heartbeat coordinator with live workers is NOT stale', () => {
  const s = makeSession({ lastHeartbeat: 'not-a-date', role: 'coordinator' })
  assert.equal(isSessionStale(s, DEFAULT_STALE_MS, Date.now(), 1), false)
})

// ---------------------------------------------------------------------------
// findConflicts
// ---------------------------------------------------------------------------

console.log('\nfindConflicts')

test('no conflicts when each file is claimed by at most one session', () => {
  const sessions = [
    makeSession({ id: 'cr_a', claimedFiles: [{ path: 'src/a.ts', claimedAt: '' }] }),
    makeSession({ id: 'cr_b', claimedFiles: [{ path: 'src/b.ts', claimedAt: '' }] }),
  ]
  assert.deepEqual(findConflicts(sessions), [])
})

test('conflict detected when two sessions claim the same file', () => {
  const sessions = [
    makeSession({ id: 'cr_a', claimedFiles: [{ path: 'src/shared.ts', claimedAt: '' }] }),
    makeSession({ id: 'cr_b', claimedFiles: [{ path: 'src/shared.ts', claimedAt: '' }] }),
  ]
  const conflicts = findConflicts(sessions)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].path, 'src/shared.ts')
  assert.ok(conflicts[0].sessionIds.includes('cr_a'))
  assert.ok(conflicts[0].sessionIds.includes('cr_b'))
})

test('multiple conflicts detected', () => {
  const sessions = [
    makeSession({ id: 'cr_a', claimedFiles: [{ path: 'src/x.ts', claimedAt: '' }, { path: 'src/y.ts', claimedAt: '' }] }),
    makeSession({ id: 'cr_b', claimedFiles: [{ path: 'src/x.ts', claimedAt: '' }, { path: 'src/y.ts', claimedAt: '' }] }),
  ]
  const conflicts = findConflicts(sessions)
  assert.equal(conflicts.length, 2)
  const paths = conflicts.map((c) => c.path).sort()
  assert.deepEqual(paths, ['src/x.ts', 'src/y.ts'])
})

test('empty sessions list = no conflicts', () => {
  assert.deepEqual(findConflicts([]), [])
})

test('sessions with empty claimedFiles = no conflicts', () => {
  const sessions = [makeSession({ id: 'cr_a' }), makeSession({ id: 'cr_b' })]
  assert.deepEqual(findConflicts(sessions), [])
})

// ---------------------------------------------------------------------------
// toRepoRelative
// ---------------------------------------------------------------------------

console.log('\ntoRepoRelative')

test('absolute path within cwd returns relative', () => {
  const abs = path.join(process.cwd(), 'src', 'index.ts')
  assert.equal(toRepoRelative(abs), 'src/index.ts')
})

test('relative path returns as-is (forward slashes)', () => {
  assert.equal(toRepoRelative('src/index.ts'), 'src/index.ts')
})

// ---------------------------------------------------------------------------
// generateSessionId
// ---------------------------------------------------------------------------

console.log('\ngenerateSessionId')

test('returns string starting with cr_', () => {
  const id = generateSessionId()
  assert.ok(id.startsWith('cr_'), `Expected cr_ prefix, got: ${id}`)
})

test('returns different values on each call', () => {
  const a = generateSessionId()
  const b = generateSessionId()
  assert.notEqual(a, b)
})

test('id has expected length (cr_ + 12 hex chars)', () => {
  const id = generateSessionId()
  assert.ok(/^cr_[0-9a-f]{12}$/.test(id), `Unexpected format: ${id}`)
})

// ---------------------------------------------------------------------------
// Filesystem: write / read / delete
// ---------------------------------------------------------------------------

console.log('\nfilesystem (writeSessionAtomic / readSession / deleteSession / listSessions)')

fs.mkdirSync(path.join('.pipemd', 'crew'), { recursive: true })

test('write then read round-trip', () => {
  const id = testId()
  const s = makeSession({ id, lastHeartbeat: new Date().toISOString() })
  writeSessionAtomic(s)
  const read = readSession(id)
  assert.ok(read, 'readSession should return a session')
  assert.equal(read!.id, id)
  assert.equal(read!.role, 'coordinator')
  assert.equal(read!.harness, 'TestHarness')
  cleanupTestSessions()
})

test('read non-existent returns null', () => {
  assert.equal(readSession('cr_nonexistent_00000000'), null)
})

test('delete removes the file', () => {
  const id = testId()
  writeSessionAtomic(makeSession({ id }))
  assert.ok(readSession(id), 'should exist before delete')
  deleteSession(id)
  assert.equal(readSession(id), null, 'should be gone after delete')
})

test('delete non-existent does not throw', () => {
  assert.doesNotThrow(() => deleteSession('cr_no_such_session'))
})

test('listSessions returns sessions from JSON files', () => {
  const id1 = testId()
  const id2 = testId()
  writeSessionAtomic(makeSession({ id: id1 }))
  writeSessionAtomic(makeSession({ id: id2 }))
  const ids = listSessions().map((s) => s.id)
  assert.ok(ids.includes(id1), `should include ${id1}`)
  assert.ok(ids.includes(id2), `should include ${id2}`)
  cleanupTestSessions()
})

test('listSessions skips malformed JSON files', () => {
  const badId = testId() + '_bad'
  const badPath = path.join('.pipemd', 'crew', `${badId}.json`)
  fs.writeFileSync(badPath, '{{not json}}')
  const ids = listSessions().map((s) => s.id)
  assert.ok(!ids.includes(badId), 'should skip malformed file')
  try { fs.unlinkSync(badPath) } catch {}
})

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log('')
console.log('\x1b[1;33m═══ Results ═══\x1b[0m')
console.log(`  \x1b[32mPASS\x1b[0m: ${passed}`)
console.log(`  \x1b[31mFAIL\x1b[0m: ${failed}`)

if (failed > 0) {
  console.log(`\n\x1b[31m✖ crew tests failed\x1b[0m`)
  process.exit(1)
} else {
  console.log(`\n\x1b[32m✔ All crew tests passed\x1b[0m`)
  process.exit(0)
}
