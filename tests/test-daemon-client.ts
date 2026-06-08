import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MockRelay, readBody } from "./helpers/mock-relay.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-client-test-"));
fs.mkdirSync(path.join(tmpDir, ".pipemd", "crew"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "sources"), { recursive: true });

const origDir = process.cwd();
process.chdir(tmpDir);

import type { CrewSession } from "../src/core/crew.js";
const { setRemoteSessions, getRemoteSessions, clearRemoteSessions, writeSessionAtomic, invalidateSessionListCache } = await import("../src/core/crew.js");

function makeSession(overrides: Partial<CrewSession> = {}): CrewSession {
  return {
    schema: 1,
    id: overrides.id || "cr_client_test",
    role: "coordinator",
    harness: "TestHarness",
    pid: 99999,
    ppid: 1,
    coordinatorId: null,
    claimedFiles: [],
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    cwd: tmpDir,
    ...overrides,
  };
}

describe("syncWithRelay", () => {
  const mock = new MockRelay();

  before(async () => {
    await mock.start();
    mock.on("POST", "/crew", async (req, res) => {
      const raw = await readBody(req);
      const msg = JSON.parse(raw);
      mock.json(res, 200, {
        sessions: [
          { ...makeSession({ id: "cr_remote_from_relay" }), _remote: true, _origin: "other-host" },
        ],
      });
    });
  });

  after(async () => {
    await mock.stop();
  });

  it("syncs sessions with relay and stores remote sessions", async () => {
    const { syncWithRelay } = await import("../src/core/net/daemon-client.js");
    const local = makeSession({ id: "cr_local_sync" });
    writeSessionAtomic(local);

    process.env.PMD_RELAY = `${mock.url()}/crew`;
    const remote = await syncWithRelay("test-group", [local]);
    delete process.env.PMD_RELAY;

    assert.ok(remote.length > 0);
    assert.equal(remote[0].id, "cr_remote_from_relay");
    assert.equal(remote[0]._remote, true);
  });

  it("returns empty array when PMD_RELAY is not set", async () => {
    delete process.env.PMD_RELAY;
    const { syncWithRelay } = await import("../src/core/net/daemon-client.js");
    const result = await syncWithRelay("test-group", []);
    assert.equal(result.length, 0);
  });

  it("handles connection refused gracefully", async () => {
    process.env.PMD_RELAY = "http://127.0.0.1:1";
    const { syncWithRelay } = await import("../src/core/net/daemon-client.js");
    const result = await syncWithRelay("test-group", []);
    delete process.env.PMD_RELAY;
    assert.equal(result.length, 0);
  });
});

describe("remote session management", () => {
  after(() => {
    clearRemoteSessions();
    invalidateSessionListCache();
  });

  it("stores and retrieves remote sessions", () => {
    const remote = makeSession({ id: "cr_remote_store" });
    setRemoteSessions([{ ...remote, _remote: true as const, _origin: "remote-host" }]);
    const stored = getRemoteSessions();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, "cr_remote_store");
  });

  it("clears remote sessions", () => {
    setRemoteSessions([{ ...makeSession({ id: "cr_clear" }), _remote: true as const, _origin: "h" }]);
    clearRemoteSessions();
    assert.equal(getRemoteSessions().length, 0);
  });
});
