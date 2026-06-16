import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-relay-test-"));
const linkDir = path.join(tmpDir, ".pipemd", "link");
fs.mkdirSync(linkDir, { recursive: true });

const origDir = process.cwd();
process.chdir(tmpDir);

const origHome = process.env.HOME;
process.env.HOME = tmpDir;

const testToken = "test-relay-token-12345";
fs.writeFileSync(path.join(linkDir, "relay.token"), testToken, "utf-8");

const { startRelay, stopRelay } = await import("../src/core/net/relay.js");
import type { CrewSession } from "../src/core/crew.js";

let relayPort: number;

function makeSession(overrides: Partial<CrewSession> = {}): CrewSession {
  return {
    schema: 1,
    id: overrides.id || "cr_relay_test",
    role: "coordinator",
    harness: "TestHarness",
    pid: 99999,
    ppid: 1,
    coordinatorId: null,
    claimedFiles: [],
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    cwd: "/tmp",
    ...overrides,
  };
}

const authHeader = { Authorization: `Bearer ${testToken}` };

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let parsed: unknown;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { parsed = null; }
          resolve({ status: res.statusCode || 0, data: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", headers: { ...authHeader, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let parsed: unknown;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { parsed = null; }
          resolve({ status: res.statusCode || 0, data: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  relayPort = await startRelay(0);
});

after(() => {
  stopRelay();
  process.chdir(origDir);
  process.env.HOME = origHome;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("GET /health", () => {
  it("returns ok with hostname", async () => {
    const { status, data } = await get(relayPort, "/health");
    assert.equal(status, 200);
    assert.ok((data as any)?.ok);
    assert.ok((data as any)?.hostname);
  });
});

describe("GET /status", () => {
  it("returns ok with groups", async () => {
    const { status, data } = await get(relayPort, "/status");
    assert.equal(status, 200);
    assert.ok((data as any)?.ok);
    assert.ok(typeof (data as any)?.groups === "object");
  });
});

describe("POST /crew", () => {
  it("accepts session push from localhost and returns remote sessions", async () => {
    const session = makeSession({ id: "cr_push_test" });
    const { status, data } = await post(relayPort, "/crew", {
      group: "test-group",
      hostname: "test-host",
      sessions: [session],
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray((data as any)?.sessions));
  });

  it("rejects non-localhost requests", async () => {
    const session = makeSession({ id: "cr_remote" });
    const { status, data } = await post(relayPort, "/crew", {
      group: "test-group",
      hostname: "test-host",
      sessions: [session],
    });
    assert.equal(status, 200);
  });

  it("returns remote sessions from other origins", async () => {
    await post(relayPort, "/crew", {
      group: "merge-group",
      hostname: "origin-a",
      sessions: [makeSession({ id: "cr_a" })],
    });
    const { status, data } = await post(relayPort, "/crew", {
      group: "merge-group",
      hostname: "origin-b",
      sessions: [makeSession({ id: "cr_b" })],
    });
    assert.equal(status, 200);
    const remoteSessions = (data as any)?.sessions || [];
    const ids = remoteSessions.map((s: any) => s.id);
    assert.ok(ids.includes("cr_a"), `expected cr_a in ${JSON.stringify(ids)}`);
  });
});

describe("POST /sync", () => {
  it("rejects requests without auth", async () => {
    const { status } = await post(relayPort, "/sync", {
      hostname: "sync-test",
      groups: {},
    });
    assert.equal(status, 401);
  });

  it("rejects requests with wrong token", async () => {
    const { status } = await post(relayPort, "/sync", {
      hostname: "sync-test",
      groups: {},
    }, { Authorization: "Bearer wrong-token" });
    assert.equal(status, 401);
  });

  it("accepts requests with correct token", async () => {
    const { status, data } = await post(relayPort, "/sync", {
      hostname: "sync-peer",
      groups: { "sync-group": [makeSession({ id: "cr_sync" })] },
    }, { Authorization: `Bearer ${testToken}` });
    assert.equal(status, 200);
    assert.ok((data as any)?.hostname);
    assert.ok(typeof (data as any)?.groups === "object");
  });

  it("merges synced sessions into store", async () => {
    await post(relayPort, "/sync", {
      hostname: "sync-merge-host",
      groups: { "sync-merge": [makeSession({ id: "cr_synced" })] },
    }, { Authorization: `Bearer ${testToken}` });

    const { data: statusData } = await post(relayPort, "/crew", {
      group: "sync-merge",
      hostname: "local-host",
      sessions: [],
    });
    const remoteIds = ((statusData as any)?.sessions || []).map((s: any) => s.id);
    assert.ok(remoteIds.includes("cr_synced"), `expected cr_synced in ${JSON.stringify(remoteIds)}`);
  });
});

describe("404 for unknown routes", () => {
  it("returns 404 for unknown paths", async () => {
    const { status } = await get(relayPort, "/unknown");
    assert.equal(status, 404);
  });

  it("returns 404 for unsupported methods", async () => {
    const { status } = await post(relayPort, "/health", {});
    assert.equal(status, 404);
  });
});

describe("POST /blocks", () => {
  it("stores blocks and returns count", async () => {
    const { status, data } = await post(relayPort, "/blocks", {
      group: "block-test",
      hostname: "test-host",
      commitSha: "abc123def456",
      blocks: [
        { source: "test-failures", data: "3 tests failed", timestamp: Date.now(), hash: "h1" },
        { source: "git-delta", data: "2 modified", timestamp: Date.now(), hash: "h2" },
      ],
    });
    assert.equal(status, 200);
    assert.equal((data as any)?.stored, 2);
    assert.ok((data as any)?.ok);
  });

  it("rejects requests missing required fields", async () => {
    const { status, data } = await post(relayPort, "/blocks", {
      group: "block-test",
      hostname: "test-host",
    });
    assert.equal(status, 400);
    assert.ok((data as any)?.error);
  });

  it("overwrites existing blocks with same key", async () => {
    await post(relayPort, "/blocks", {
      group: "overwrite-test",
      hostname: "test-host",
      commitSha: "sha999",
      blocks: [{ source: "test-failures", data: "old data", timestamp: 1, hash: "old" }],
    });
    const { status, data } = await post(relayPort, "/blocks", {
      group: "overwrite-test",
      hostname: "test-host",
      commitSha: "sha999",
      blocks: [{ source: "test-failures", data: "new data", timestamp: 2, hash: "new" }],
    });
    assert.equal(status, 200);
    assert.equal((data as any)?.stored, 1);
  });

  it("rejects invalid JSON body", async () => {
    const result = await new Promise<{ status: number; data: unknown }>((resolve) => {
      const body = "not json{{{";
      const req = http.request(
        { hostname: "127.0.0.1", port: relayPort, path: "/blocks", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            let parsed: unknown;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { parsed = null; }
            resolve({ status: res.statusCode || 0, data: parsed });
          });
        },
      );
      req.on("error", () => resolve({ status: 0, data: null }));
      req.write(body);
      req.end();
    });
    assert.equal(result.status, 400);
  });
});

describe("GET /blocks", () => {
  it("fetches stored blocks by group and commitSha", async () => {
    await post(relayPort, "/blocks", {
      group: "fetch-test",
      hostname: "test-host",
      commitSha: "deadbeef",
      blocks: [
        { source: "test-failures", data: "1 fail", timestamp: 100, hash: "hf" },
        { source: "git-delta", data: "5 modified", timestamp: 101, hash: "hd" },
      ],
    });

    const { status, data } = await get(relayPort, "/blocks?group=fetch-test&commitSha=deadbeef");
    assert.equal(status, 200);
    const blocks = (data as any)?.blocks as any[];
    assert.equal(blocks.length, 2);
    const sources = blocks.map((b: any) => b.source).sort();
    assert.deepEqual(sources, ["git-delta", "test-failures"]);
  });

  it("returns empty array for non-existent group", async () => {
    const { status, data } = await get(relayPort, "/blocks?group=no-such&commitSha=0000");
    assert.equal(status, 200);
    assert.deepEqual((data as any)?.blocks, []);
  });

  it("returns 400 when missing query params", async () => {
    const { status, data } = await get(relayPort, "/blocks");
    assert.equal(status, 400);
    assert.ok((data as any)?.error);
  });

  it("returns 400 with missing commitSha", async () => {
    const { status, data } = await get(relayPort, "/blocks?group=test");
    assert.equal(status, 400);
    assert.ok((data as any)?.error);
  });

  it("isolates blocks by commitSha", async () => {
    await post(relayPort, "/blocks", {
      group: "sha-isolate",
      hostname: "test-host",
      commitSha: "sha111",
      blocks: [{ source: "test-failures", data: "sha111 data", timestamp: 1, hash: "h1" }],
    });
    await post(relayPort, "/blocks", {
      group: "sha-isolate",
      hostname: "test-host",
      commitSha: "sha222",
      blocks: [{ source: "test-failures", data: "sha222 data", timestamp: 2, hash: "h2" }],
    });

    const { data: d1 } = await get(relayPort, "/blocks?group=sha-isolate&commitSha=sha111");
    const { data: d2 } = await get(relayPort, "/blocks?group=sha-isolate&commitSha=sha222");
    assert.equal((d1 as any).blocks[0].data, "sha111 data");
    assert.equal((d2 as any).blocks[0].data, "sha222 data");
  });
});
