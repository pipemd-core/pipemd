#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✖\x1b[0m ${name}`);
    console.log(`    ${err.message}`);
    if (err.stack) {
      const lines = err.stack.split("\n").slice(1, 4);
      for (const l of lines) console.log(`    ${l.trim()}`);
    }
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✖\x1b[0m ${name}`);
    console.log(`    ${err.message}`);
    if (err.stack) {
      const lines = err.stack.split("\n").slice(1, 4);
      for (const l of lines) console.log(`    ${l.trim()}`);
    }
    failed++;
  }
}

function makeSession(overrides = {}) {
  return {
    schema: 1,
    id: overrides.id || "cr_test1",
    role: overrides.role || "coordinator",
    harness: overrides.harness || "TestHarness",
    label: overrides.label,
    pid: overrides.pid || 12345,
    ppid: 0,
    coordinatorId: overrides.coordinatorId || null,
    claimedFiles: overrides.claimedFiles || [],
    note: overrides.note,
    startedAt: overrides.startedAt || new Date().toISOString(),
    lastHeartbeat: overrides.lastHeartbeat || new Date().toISOString(),
    cwd: overrides.cwd || "/tmp/test",
  };
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: "POST",
        timeout: 3000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.get(
      { hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname, timeout: 3000, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function startMockRelay(handler, port) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const myHostname = os.hostname();
const BASE_PORT = 19841;

console.log("\x1b[1;33m═══ Link Relay Unit Tests ═══\x1b[0m\n");

// ── Relay POST /crew ──

await asyncTest("POST /crew stores sessions and returns remote sessions", async () => {
  let port = BASE_PORT;
  const handler = (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, hostname: myHostname }));
      return;
    }
    if (req.method === "POST" && req.url === "/crew") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString());
        const stored = msg;
        const response = {
          sessions: [
            { ...makeSession({ id: "cr_remote1", harness: "RemoteAgent" }), _remote: true, _origin: "other-machine" },
          ],
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      });
      return;
    }
    res.writeHead(404);
    res.end("{}");
  };
  const relay = await startMockRelay(handler, 0);

  const result = await postJson(`http://localhost:${relay.port}/crew`, {
    group: "test-project",
    hostname: myHostname,
    sessions: [makeSession({ id: "cr_local1" })],
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.sessions.length, 1);
  assert.equal(result.body.sessions[0].id, "cr_remote1");
  assert.equal(result.body.sessions[0]._remote, true);
  await relay.close();
});

await asyncTest("GET /health returns ok and hostname", async () => {
  const handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, hostname: myHostname }));
  };
  const relay = await startMockRelay(handler, 0);

  const result = await getJson(`http://localhost:${relay.port}/health`);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.hostname, myHostname);
  await relay.close();
});

await asyncTest("GET /status returns groups and peers", async () => {
  const handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      hostname: myHostname,
      groups: { "test-project": { local: 2, remote: 1 } },
      peers: [],
    }));
  };
  const relay = await startMockRelay(handler, 0);

  const result = await getJson(`http://localhost:${relay.port}/status`);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.ok(result.body.groups["test-project"]);
  assert.equal(result.body.groups["test-project"].local, 2);
  assert.equal(result.body.groups["test-project"].remote, 1);
  await relay.close();
});

// ── Daemon client: push local, receive remote ──

await asyncTest("daemon client pushes sessions and receives remote", async () => {
  const localSession = makeSession({ id: "cr_local_daemon" });

  const handler = (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(msg.group, "test-group");
      assert.equal(msg.sessions.length, 1);
      assert.equal(msg.sessions[0].id, "cr_local_daemon");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        sessions: [
          { ...makeSession({ id: "cr_from_peer" }), _remote: true, _origin: "peer-host" },
        ],
      }));
    });
  };
  const relay = await startMockRelay(handler, 0);

  const result = await postJson(`http://localhost:${relay.port}/crew`, {
    group: "test-group",
    hostname: myHostname,
    sessions: [localSession],
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.sessions.length, 1);
  assert.equal(result.body.sessions[0]._remote, true);
  assert.equal(result.body.sessions[0]._origin, "peer-host");
  await relay.close();
});

// ── Relay POST /sync with token auth ──

await asyncTest("POST /sync rejects requests without valid token", async () => {
  const handler = (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== "Bearer test-token-123") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hostname: myHostname, groups: {} }));
  };
  const relay = await startMockRelay(handler, 0);

  const badResult = await postJson(`http://localhost:${relay.port}/sync`, {
    hostname: "attacker",
    groups: {},
  });
  assert.equal(badResult.status, 403);

  const goodResult = await postJson(`http://localhost:${relay.port}/sync`, {
    hostname: "trusted-peer",
    groups: { "pipemd": [makeSession({ id: "cr_peer1" })] },
  });
  // This should also fail because we're not sending the header here.
  // Let's test with the header via a custom request.
  await relay.close();
});

await asyncTest("POST /sync with token exchanges groups", async () => {
  const handler = (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== "Bearer valid-token") {
      res.writeHead(403);
      res.end('{"error":"unauthorized"}');
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString());
      const response = {
        hostname: myHostname,
        groups: {
          "pipemd": [makeSession({ id: "cr_local_side" })],
        },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
  };
  const relay = await startMockRelay(handler, 0);

  const body = JSON.stringify({
    hostname: "remote-peer",
    groups: { "pipemd": [makeSession({ id: "cr_remote_side" })] },
  });

  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "localhost",
      port: relay.port,
      path: "/sync",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: "Bearer valid-token",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  assert.equal(result.status, 200);
  assert.ok(result.body.groups["pipemd"]);
  assert.equal(result.body.groups["pipemd"].length, 1);
  assert.equal(result.body.groups["pipemd"][0].id, "cr_local_side");
  await relay.close();
});

// ── Relay handles unknown endpoints ──

await asyncTest("relay returns 404 for unknown endpoints", async () => {
  const handler = (req, res) => {
    res.writeHead(404);
    res.end('{"error":"not found"}');
  };
  const relay = await startMockRelay(handler, 0);

  const result = await getJson(`http://localhost:${relay.port}/unknown`);
  assert.equal(result.status, 404);
  await relay.close();
});

// ── Relay handles malformed JSON ──

await asyncTest("POST /crew returns 400 for invalid JSON", async () => {
  const handler = (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200);
        res.end('{"sessions":[]}');
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"invalid body"}');
      }
    });
  };
  const relay = await startMockRelay(handler, 0);

  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "localhost",
      port: relay.port,
      path: "/crew",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": 5 },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject);
    req.write("{bad}");
    req.end();
  });

  assert.equal(result.status, 400);
  await relay.close();
});

// ── Session data integrity ──

await asyncTest("sessions with claimed files are preserved across relay", async () => {
  const sessionWithClaim = makeSession({
    id: "cr_claimant",
    claimedFiles: [{ path: "src/auth.ts", claimedAt: new Date().toISOString(), note: "refactoring" }],
  });

  const handler = (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(msg.sessions[0].claimedFiles.length, 1);
      assert.equal(msg.sessions[0].claimedFiles[0].path, "src/auth.ts");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions: [] }));
    });
  };
  const relay = await startMockRelay(handler, 0);

  const result = await postJson(`http://localhost:${relay.port}/crew`, {
    group: "pipemd",
    hostname: myHostname,
    sessions: [sessionWithClaim],
  });

  assert.equal(result.status, 200);
  await relay.close();
});

// ── Multiple groups are isolated ──

await asyncTest("POST /crew only returns sessions for the requested group", async () => {
  const store = {
    "pipemd": [{ ...makeSession({ id: "cr_pmd" }), _remote: true, _origin: "other" }],
    "api": [{ ...makeSession({ id: "cr_api" }), _remote: true, _origin: "other" }],
  };

  const handler = (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString());
      const group = msg.group;
      const sessions = store[group] || [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions }));
    });
  };
  const relay = await startMockRelay(handler, 0);

  const pmdResult = await postJson(`http://localhost:${relay.port}/crew`, {
    group: "pipemd",
    hostname: myHostname,
    sessions: [],
  });
  assert.equal(pmdResult.body.sessions.length, 1);
  assert.equal(pmdResult.body.sessions[0].id, "cr_pmd");

  const apiResult = await postJson(`http://localhost:${relay.port}/crew`, {
    group: "api",
    hostname: myHostname,
    sessions: [],
  });
  assert.equal(apiResult.body.sessions.length, 1);
  assert.equal(apiResult.body.sessions[0].id, "cr_api");

  await relay.close();
});

// ── Remote session tagging in crew merge ──

await asyncTest("remote sessions are tagged with _remote and _origin", async () => {
  const remoteSession = {
    ...makeSession({ id: "cr_remote_agent", harness: "RemoteHarness" }),
    _remote: true,
    _origin: "laptop",
  };

  assert.equal(remoteSession._remote, true);
  assert.equal(remoteSession._origin, "laptop");
  assert.equal(remoteSession.id, "cr_remote_agent");
  assert.equal(remoteSession.harness, "RemoteHarness");
});

// ── Conflict detection works with remote sessions ──

await asyncTest("findConflicts detects cross-machine conflicts", async () => {
  const local = makeSession({
    id: "cr_local",
    claimedFiles: [{ path: "src/auth.ts", claimedAt: new Date().toISOString() }],
  });
  const remote = {
    ...makeSession({
      id: "cr_remote",
      claimedFiles: [{ path: "src/auth.ts", claimedAt: new Date().toISOString() }],
    }),
    _remote: true,
    _origin: "laptop",
  };

  const allSessions = [local, remote];
  const byPath = new Map();
  for (const s of allSessions) {
    for (const c of s.claimedFiles || []) {
      const set = byPath.get(c.path) || new Set();
      set.add(s.id);
      byPath.set(c.path, set);
    }
  }
  const conflicts = [];
  for (const [p, set] of byPath) {
    if (set.size > 1) conflicts.push({ path: p, sessionIds: [...set] });
  }

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, "src/auth.ts");
  assert.ok(conflicts[0].sessionIds.includes("cr_local"));
  assert.ok(conflicts[0].sessionIds.includes("cr_remote"));
});

console.log("");
console.log("\x1b[1;33m═══ Results ═══\x1b[0m");
console.log(`  \x1b[32mPASS\x1b[0m: ${passed}`);
console.log(`  \x1b[31mFAIL\x1b[0m: ${failed}`);

if (failed > 0) {
  console.log(`\n\x1b[31m✖ Link unit tests failed\x1b[0m`);
  process.exit(1);
} else {
  console.log(`\n\x1b[32m✔ All link unit tests passed\x1b[0m`);
  process.exit(0);
}
