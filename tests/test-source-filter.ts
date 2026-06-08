import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-source-filter-test-"));
fs.mkdirSync(path.join(tmpDir, ".pipemd"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".pipemd", "crew"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "sources"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "validation"), { recursive: true });

fs.writeFileSync(
  path.join(tmpDir, ".pipemd", "injection.yml"),
  `delivery: active
rules:
  on-idle:
    - source: test-failures
      scope: global
    - source: git-delta
      scope: global
    - source: syntax-check
      scope: global
`,
);

const origDir = process.cwd();
process.chdir(tmpDir);

const { writeSessionAtomic, readSession, deleteSession, listSessions, joinSession, resolveActiveSession, invalidateSessionListCache } = await import("../src/core/crew.js");
import type { CrewSession } from "../src/core/crew.js";

function makeSession(overrides: Partial<CrewSession> = {}): CrewSession {
  return {
    schema: 1,
    id: overrides.id || "cr_filter_test",
    role: "coordinator",
    harness: "TestHarness",
    pid: 99999,
    ppid: 1,
    coordinatorId: null,
    claimedFiles: [],
    sources: overrides.sources,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    cwd: tmpDir,
    ...overrides,
  };
}

after(() => {
  process.chdir(origDir);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("CrewSession.sources field", () => {
  it("persists sources array in session file", () => {
    const session = makeSession({ id: "cr_src_persist", sources: ["test-failures", "git-delta"] });
    writeSessionAtomic(session);
    invalidateSessionListCache();
    const read = readSession("cr_src_persist");
    assert.ok(read);
    assert.deepEqual(read!.sources, ["test-failures", "git-delta"]);
  });

  it("persists undefined sources as undefined", () => {
    const session = makeSession({ id: "cr_src_undef" });
    writeSessionAtomic(session);
    invalidateSessionListCache();
    const read = readSession("cr_src_undef");
    assert.ok(read);
    assert.equal(read!.sources, undefined);
  });

  it("persists empty sources array", () => {
    const session = makeSession({ id: "cr_src_empty", sources: [] });
    writeSessionAtomic(session);
    invalidateSessionListCache();
    const read = readSession("cr_src_empty");
    assert.ok(read);
    assert.deepEqual(read!.sources, []);
  });

  it("round-trips sources through JSON serialization", () => {
    const sources = ["test-failures", "git-delta", "git-diff-stat", "git-staged", "context-rules"];
    const session = makeSession({ id: "cr_src_round", sources });
    writeSessionAtomic(session);
    invalidateSessionListCache();
    const read = readSession("cr_src_round");
    assert.ok(read);
    assert.deepEqual(read!.sources, sources);
  });
});

describe("joinSession with sources option", () => {
  after(() => {
    for (const s of listSessions()) {
      deleteSession(s.id);
    }
    invalidateSessionListCache();
  });

  it("sets sources on new session", () => {
    const session = joinSession({ sources: ["test-failures"] });
    assert.deepEqual(session.sources, ["test-failures"]);
    deleteSession(session.id);
    invalidateSessionListCache();
  });

  it("preserves sources when updating existing session without new sources", () => {
    const first = joinSession({ sources: ["git-delta"] });
    const firstId = first.id;
    invalidateSessionListCache();

    process.env.PMD_SESSION = firstId;
    try {
      const second = joinSession({});
      assert.equal(second.id, firstId);
      assert.deepEqual(second.sources, ["git-delta"]);
    } finally {
      delete process.env.PMD_SESSION;
    }
    deleteSession(firstId);
    invalidateSessionListCache();
  });

  it("overwrites sources when updating with new sources", () => {
    const first = joinSession({ sources: ["git-delta"] });
    const firstId = first.id;
    invalidateSessionListCache();

    process.env.PMD_SESSION = firstId;
    try {
      const second = joinSession({ sources: ["test-failures", "syntax-check"] });
      assert.equal(second.id, firstId);
      assert.deepEqual(second.sources, ["test-failures", "syntax-check"]);
    } finally {
      delete process.env.PMD_SESSION;
    }
    deleteSession(firstId);
    invalidateSessionListCache();
  });

  it("does not set sources when none provided", () => {
    const session = joinSession({});
    assert.equal(session.sources, undefined);
    deleteSession(session.id);
    invalidateSessionListCache();
  });
});
