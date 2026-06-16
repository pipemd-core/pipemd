import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { CrewSession } from "../src/core/crew.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-relay-sync-"));
const linkDir = path.join(tmpDir, ".pipemd", "link");
fs.mkdirSync(linkDir, { recursive: true });

const workspaceDir = path.join(tmpDir, ".pipemd", "workspaces", "agent-001");
fs.mkdirSync(workspaceDir, { recursive: true });
fs.writeFileSync(path.join(workspaceDir, "context.md"), "# Agent 001 Context\nHello from agent-001.", "utf-8");

const origHome = process.env.HOME;
process.env.HOME = tmpDir;

const testToken = "test-relay-sync-token-42";
fs.writeFileSync(path.join(linkDir, "relay.token"), testToken, "utf-8");

const peersFile = path.join(linkDir, "peers.json");

const { startRelay, stopRelay, syncWithPeers } = await import("../src/core/net/relay.js");

let relayPort: number;

function makeSession(overrides: Partial<CrewSession> = {}): CrewSession {
  return {
    schema: 1,
    id: overrides.id || "cr_sync_test",
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

function request(
  port: number,
  method: string,
  urlPath: string,
  body: unknown = null,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const reqHeaders: Record<string, string> = { ...headers };
    if (data != null) {
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = String(Buffer.byteLength(data));
    }
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers: reqHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode || 0, data: parsed });
        });
      },
    );
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}

const authHeader = { Authorization: `Bearer ${testToken}` };

const get = (port: number, p: string, h: Record<string, string> = {}) =>
  request(port, "GET", p, null, { ...authHeader, ...h });
const post = (
  port: number,
  p: string,
  b: unknown,
  h: Record<string, string> = {},
) => request(port, "POST", p, b, h);

before(async () => {
  relayPort = await startRelay(0);
});

after(() => {
  stopRelay();
  process.env.HOME = origHome;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("syncWithPeers host parsing (B-1 regression)", () => {
  it("dials correct host:port for peer with explicit port", async () => {
    let captured = false;
    const captureServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        captured = true;
        const parsed = JSON.parse(body);
        assert.ok(parsed.hostname, "sync payload must include hostname");
        assert.ok(parsed.groups, "sync payload must include groups");
        res.end(JSON.stringify({ hostname: "capture-host", groups: {} }));
      });
    });
    await new Promise<void>((resolve) => captureServer.listen(0, "127.0.0.1", resolve));
    const capturePort = (captureServer.address() as any).port;

    fs.writeFileSync(
      peersFile,
      JSON.stringify([{ host: "127.0.0.1", port: capturePort, token: testToken }]),
    );

    await post(relayPort, "/crew", {
      group: "b1-regression",
      hostname: "origin-a",
      sessions: [makeSession({ id: "cr_b1" })],
    });

    syncWithPeers();
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(captured, "capture server must receive the sync request — host:port was parsed incorrectly");

    captureServer.close();
  });

  it("does not crash when peers.json has no valid entries", () => {
    fs.writeFileSync(peersFile, JSON.stringify([{ host: "127.0.0.1", token: testToken }]));
    assert.doesNotThrow(() => syncWithPeers());
  });
});

describe("readPeers validation (B-2)", () => {
  it("skips malformed entries (empty object)", () => {
    fs.writeFileSync(peersFile, JSON.stringify([{}]));
    assert.doesNotThrow(() => syncWithPeers());
  });

  it("skips entries missing token", () => {
    fs.writeFileSync(peersFile, JSON.stringify([{ host: "192.168.1.73" }]));
    assert.doesNotThrow(() => syncWithPeers());
  });

  it("skips non-array peers.json", () => {
    fs.writeFileSync(peersFile, JSON.stringify({ host: "x" }));
    assert.doesNotThrow(() => syncWithPeers());
  });

  it("handles missing peers.json gracefully", () => {
    fs.unlinkSync(peersFile);
    assert.doesNotThrow(() => syncWithPeers());
  });
});

describe("auth middleware (B-4)", () => {
  it("returns 401 for /status without token", async () => {
    const { status } = await request(relayPort, "GET", "/status", null, {});
    assert.equal(status, 401);
  });

  it("returns 401 for /status with wrong token", async () => {
    const { status } = await request(relayPort, "GET", "/status", null, {
      Authorization: "Bearer wrong",
    });
    assert.equal(status, 401);
  });

  it("returns 200 for /status with valid token", async () => {
    const { status } = await get(relayPort, "/status");
    assert.equal(status, 200);
  });

  it("returns 401 for /health without token", async () => {
    const { status } = await request(relayPort, "GET", "/health", null, {});
    assert.equal(status, 401);
  });

  it("returns 401 for /metrics without token", async () => {
    const { status } = await request(relayPort, "GET", "/metrics", null, {});
    assert.equal(status, 401);
  });

  it("returns 401 for /sync without token", async () => {
    const { status } = await post(relayPort, "/sync", { hostname: "x", groups: {} });
    assert.equal(status, 401);
  });

  it("returns 200 for /sync with valid token", async () => {
    const { status } = await post(
      relayPort,
      "/sync",
      { hostname: "auth-test", groups: {} },
      authHeader,
    );
    assert.equal(status, 200);
  });
});

describe("workspace context endpoint (B-5)", () => {
  it("returns 401 without auth", async () => {
    const { status } = await request(relayPort, "GET", "/workspace/agent-001/context", null, {});
    assert.equal(status, 401);
  });

  it("returns 404 for non-existent agent", async () => {
    const { status, data } = await get(relayPort, "/workspace/no-such-agent/context");
    assert.equal(status, 404);
    assert.ok((data as Record<string, unknown>)?.error);
  });

  it("returns 200 with content for valid agent", async () => {
    const { status, data } = await get(relayPort, "/workspace/agent-001/context");
    const d = data as Record<string, unknown>;
    assert.equal(status, 200);
    assert.ok(typeof d.last_updated === "string");
    assert.ok(typeof d.content === "string");
    assert.match(d.content as string, /Agent 001 Context/);
  });

  it("rejects path traversal with .. (normalized by URL parser)", async () => {
    const { status } = await get(relayPort, "/workspace/../etc/passwd/context");
    assert.ok(status === 400 || status === 404, `traversal must be blocked, got ${status}`);
  });

  it("rejects encoded path traversal %2e%2e%2f", async () => {
    const { status } = await request(
      relayPort,
      "GET",
      "/workspace/%2e%2e%2f%2e%2e%2fetc%2fpasswd/context",
      null,
      authHeader,
    );
    assert.equal(status, 400);
  });

  it("rejects agent_id with slashes", async () => {
    const { status } = await get(relayPort, "/workspace/../../etc/passwd/context");
    assert.ok(status === 400 || status === 404, `expected 400 or 404, got ${status}`);
  });

  it("rejects agent_id with dots", async () => {
    const { status } = await get(relayPort, "/workspace/..hidden/context");
    assert.equal(status, 400);
  });

  it("rejects encoded dots in agent_id (%2e)", async () => {
    const { status } = await request(
      relayPort,
      "GET",
      "/workspace/agent%2e001/context",
      null,
      authHeader,
    );
    assert.equal(status, 400);
  });
});
