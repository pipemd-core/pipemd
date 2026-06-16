import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { CrewSession } from "../src/core/crew.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-relay-health-"));
const linkDir = path.join(tmpDir, ".pipemd", "link");
fs.mkdirSync(linkDir, { recursive: true });

const origHome = process.env.HOME;
process.env.HOME = tmpDir;

const testToken = "test-relay-health-token-999";
fs.writeFileSync(path.join(linkDir, "relay.token"), testToken, "utf-8");

const { startRelay, stopRelay } = await import("../src/core/net/relay.js");

let relayPort: number;

function makeSession(overrides: Partial<CrewSession> = {}): CrewSession {
  return {
    schema: 1,
    id: overrides.id || "cr_health_test",
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

describe("GET /health", () => {
  it("returns 200 with ok, hostname, daemon status, uptime, peers", async () => {
    const { status, data } = await get(relayPort, "/health");
    const d = data as Record<string, unknown> | null;
    assert.equal(status, 200);
    assert.ok(d, "response body should be JSON");
    assert.equal(d!.ok, true);
    assert.ok(typeof d!.hostname === "string" && (d!.hostname as string).length > 0);
    assert.ok(
      typeof d!.daemon === "string" && (d!.daemon as string).length > 0,
      "daemon status is required",
    );
    assert.ok(
      typeof d!.uptime === "number" && (d!.uptime as number) >= 0,
      "uptime must be a non-negative number",
    );
    assert.ok(
      typeof d!.peers === "number" && (d!.peers as number) >= 0,
      "peers must be a non-negative number",
    );
  });

  it("reports uptime that is monotonically non-decreasing", async () => {
    const first = await get(relayPort, "/health");
    const up1 = (first.data as Record<string, unknown>).uptime as number;
    await new Promise((r) => setTimeout(r, 1100));
    const second = await get(relayPort, "/health");
    const up2 = (second.data as Record<string, unknown>).uptime as number;
    assert.ok(
      up2 >= up1,
      `uptime should not go backwards: ${up2} < ${up1}`,
    );
  });

  it("requires authentication (rejects invalid token)", async () => {
    const noAuth = await request(relayPort, "GET", "/health", null, {});
    assert.equal(noAuth.status, 401);

    const badAuth = await request(relayPort, "GET", "/health", null, {
      Authorization: "Bearer definitely-not-valid",
    });
    assert.equal(badAuth.status, 401);
  });
});

describe("GET /metrics", () => {
  it("returns 200 with blocks, crewSessions, syncLatencyMs, hostname", async () => {
    const { status, data } = await get(relayPort, "/metrics");
    const d = data as Record<string, unknown> | null;
    assert.equal(status, 200);
    assert.ok(d, "response body should be JSON");
    assert.ok(typeof d!.blocks === "number" && (d!.blocks as number) >= 0);
    assert.ok(
      typeof d!.crewSessions === "number" && (d!.crewSessions as number) >= 0,
    );
    assert.ok(
      d!.syncLatencyMs === null || typeof d!.syncLatencyMs === "number",
      "syncLatencyMs must be null or a number",
    );
    assert.ok(typeof d!.hostname === "string");
  });

  it("reflects newly pushed blocks in the block count", async () => {
    const before = await get(relayPort, "/metrics");
    const blocksBefore = (before.data as Record<string, unknown>).blocks as number;

    await post(relayPort, "/blocks", {
      group: "metrics-block-group",
      hostname: "metrics-host",
      commitSha: "metricsha",
      blocks: [
        { source: "test-failures", data: "x", timestamp: Date.now(), hash: "m1" },
        { source: "git-delta", data: "y", timestamp: Date.now(), hash: "m2" },
        { source: "todo", data: "z", timestamp: Date.now(), hash: "m3" },
      ],
    });

    const after = await get(relayPort, "/metrics");
    const blocksAfter = (after.data as Record<string, unknown>).blocks as number;
    assert.ok(
      blocksAfter >= blocksBefore + 3,
      `expected block count to increase by >= 3: ${blocksBefore} -> ${blocksAfter}`,
    );
  });

  it("reflects newly pushed crew sessions in the crew session count", async () => {
    const before = await get(relayPort, "/metrics");
    const crewBefore = (before.data as Record<string, unknown>)
      .crewSessions as number;

    await post(relayPort, "/crew", {
      group: "metrics-crew-group",
      hostname: "metrics-crew-host",
      sessions: [
        makeSession({ id: "cr_metrics_a" }),
        makeSession({ id: "cr_metrics_b" }),
      ],
    });

    const after = await get(relayPort, "/metrics");
    const crewAfter = (after.data as Record<string, unknown>).crewSessions as number;
    assert.ok(
      crewAfter >= crewBefore + 2,
      `expected crew count to increase by >= 2: ${crewBefore} -> ${crewAfter}`,
    );
  });

  it("reports a numeric sync latency after a peer sync handshake", async () => {
    const initial = await get(relayPort, "/metrics");
    assert.equal(
      (initial.data as Record<string, unknown>).syncLatencyMs,
      null,
      "syncLatencyMs should be null before any sync",
    );

    await post(
      relayPort,
      "/sync",
      { hostname: "latency-peer", groups: {} },
      { Authorization: `Bearer ${testToken}` },
    );

    const after = await get(relayPort, "/metrics");
    const lat = (after.data as Record<string, unknown>).syncLatencyMs;
    assert.ok(
      typeof lat === "number" && lat >= 0,
      `syncLatencyMs should be a non-negative number after sync, got ${lat}`,
    );
  });
});
