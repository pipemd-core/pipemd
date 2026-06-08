import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    id: (overrides.id as string) || "cr_test1",
    role: (overrides.role as string) || "coordinator",
    harness: (overrides.harness as string) || "TestHarness",
    label: overrides.label,
    pid: (overrides.pid as number) || 12345,
    ppid: 0,
    coordinatorId: (overrides.coordinatorId as string) || null,
    claimedFiles: (overrides.claimedFiles as unknown[]) || [],
    note: overrides.note,
    startedAt: (overrides.startedAt as string) || new Date().toISOString(),
    lastHeartbeat: (overrides.lastHeartbeat as string) || new Date().toISOString(),
    cwd: (overrides.cwd as string) || "/tmp/test",
  };
}

function postJson(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
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
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode || 0, body: JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.get(
      { hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname, timeout: 3000, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode || 0, body: JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function startMockRelay(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const myHostname = os.hostname();

describe("POST /crew", () => {
  it("stores sessions and returns remote sessions", async () => {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, hostname: myHostname }));
        return;
      }
      if (req.method === "POST" && req.url === "/crew") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            sessions: [
              { ...makeSession({ id: "cr_remote1", harness: "RemoteAgent" }), _remote: true, _origin: "other-machine" },
            ],
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end("{}");
    };
    const relay = await startMockRelay(handler);

    const result = await postJson(`http://localhost:${relay.port}/crew`, {
      group: "test-project",
      hostname: myHostname,
      sessions: [makeSession({ id: "cr_local1" })],
    });

    assert.equal(result.status, 200);
    assert.equal((result.body.sessions as unknown[]).length, 1);
    assert.equal(((result.body.sessions as Record<string, unknown>[])[0]).id, "cr_remote1");
    assert.equal(((result.body.sessions as Record<string, unknown>[])[0])._remote, true);
    await relay.close();
  });
});

describe("GET /health", () => {
  it("returns ok and hostname", async () => {
    const handler = (_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, hostname: myHostname }));
    };
    const relay = await startMockRelay(handler);

    const result = await getJson(`http://localhost:${relay.port}/health`);
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.hostname, myHostname);
    await relay.close();
  });
});

describe("GET /status", () => {
  it("returns groups and peers", async () => {
    const handler = (_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        hostname: myHostname,
        groups: { "test-project": { local: 2, remote: 1 } },
        peers: [],
      }));
    };
    const relay = await startMockRelay(handler);

    const result = await getJson(`http://localhost:${relay.port}/status`);
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    const groups = result.body.groups as Record<string, { local: number; remote: number }>;
    assert.ok(groups["test-project"]);
    assert.equal(groups["test-project"].local, 2);
    assert.equal(groups["test-project"].remote, 1);
    await relay.close();
  });
});

describe("daemon client integration", () => {
  it("pushes sessions and receives remote", async () => {
    const localSession = makeSession({ id: "cr_local_daemon" });

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
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
    const relay = await startMockRelay(handler);

    const result = await postJson(`http://localhost:${relay.port}/crew`, {
      group: "test-group",
      hostname: myHostname,
      sessions: [localSession],
    });

    assert.equal(result.status, 200);
    assert.equal((result.body.sessions as unknown[]).length, 1);
    assert.equal(((result.body.sessions as Record<string, unknown>[])[0])._remote, true);
    assert.equal(((result.body.sessions as Record<string, unknown>[])[0])._origin, "peer-host");
    await relay.close();
  });
});

describe("token auth", () => {
  it("POST /sync rejects requests without valid token", async () => {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const auth = req.headers.authorization;
      if (auth !== "Bearer test-token-123") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hostname: myHostname, groups: {} }));
    };
    const relay = await startMockRelay(handler);

    const badResult = await postJson(`http://localhost:${relay.port}/sync`, {
      hostname: "attacker",
      groups: {},
    });
    assert.equal(badResult.status, 403);
    await relay.close();
  });

  it("POST /sync with token exchanges groups", async () => {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const auth = req.headers.authorization;
      if (auth !== "Bearer valid-token") {
        res.writeHead(403);
        res.end('{"error":"unauthorized"}');
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          hostname: myHostname,
          groups: {
            "pipemd": [makeSession({ id: "cr_local_side" })],
          },
        }));
      });
    };
    const relay = await startMockRelay(handler);

    const body = JSON.stringify({
      hostname: "remote-peer",
      groups: { "pipemd": [makeSession({ id: "cr_remote_side" })] },
    });

    const result = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
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
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    assert.equal(result.status, 200);
    const groups = result.body.groups as Record<string, Record<string, unknown>[]>;
    assert.ok(groups["pipemd"]);
    assert.equal(groups["pipemd"].length, 1);
    assert.equal(groups["pipemd"][0].id, "cr_local_side");
    await relay.close();
  });
});

describe("error handling", () => {
  it("returns 404 for unknown endpoints", async () => {
    const handler = (_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(404);
      res.end('{"error":"not found"}');
    };
    const relay = await startMockRelay(handler);

    const result = await getJson(`http://localhost:${relay.port}/unknown`);
    assert.equal(result.status, 404);
    await relay.close();
  });

  it("POST /crew returns 400 for invalid JSON", async () => {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
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
    const relay = await startMockRelay(handler);

    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request({
        hostname: "localhost",
        port: relay.port,
        path: "/crew",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": 5 },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0 }));
      });
      req.on("error", reject);
      req.write("{bad}");
      req.end();
    });

    assert.equal(result.status, 400);
    await relay.close();
  });
});

describe("session data integrity", () => {
  it("claimed files are preserved across relay", async () => {
    const sessionWithClaim = makeSession({
      id: "cr_claimant",
      claimedFiles: [{ path: "src/auth.ts", claimedAt: new Date().toISOString(), note: "refactoring" }],
    });

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(msg.sessions[0].claimedFiles.length, 1);
        assert.equal(msg.sessions[0].claimedFiles[0].path, "src/auth.ts");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessions: [] }));
      });
    };
    const relay = await startMockRelay(handler);

    const result = await postJson(`http://localhost:${relay.port}/crew`, {
      group: "pipemd",
      hostname: myHostname,
      sessions: [sessionWithClaim],
    });

    assert.equal(result.status, 200);
    await relay.close();
  });
});

describe("group isolation", () => {
  it("POST /crew only returns sessions for the requested group", async () => {
    const store: Record<string, Record<string, unknown>[]> = {
      "pipemd": [{ ...makeSession({ id: "cr_pmd" }), _remote: true, _origin: "other" }],
      "api": [{ ...makeSession({ id: "cr_api" }), _remote: true, _origin: "other" }],
    };

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString());
        const group = msg.group;
        const sessions = store[group] || [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessions }));
      });
    };
    const relay = await startMockRelay(handler);

    const pmdResult = await postJson(`http://localhost:${relay.port}/crew`, {
      group: "pipemd",
      hostname: myHostname,
      sessions: [],
    });
    assert.equal((pmdResult.body.sessions as unknown[]).length, 1);
    assert.equal(((pmdResult.body.sessions as Record<string, unknown>[])[0]).id, "cr_pmd");

    const apiResult = await postJson(`http://localhost:${relay.port}/crew`, {
      group: "api",
      hostname: myHostname,
      sessions: [],
    });
    assert.equal((apiResult.body.sessions as unknown[]).length, 1);
    assert.equal(((apiResult.body.sessions as Record<string, unknown>[])[0]).id, "cr_api");

    await relay.close();
  });
});

describe("remote session tagging", () => {
  it("remote sessions carry _remote and _origin metadata", () => {
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
});

describe("cross-machine conflict detection", () => {
  it("findConflicts detects conflicts between local and remote sessions", () => {
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

    const allSessions = [local, remote] as Record<string, unknown>[];
    const byPath = new Map<string, Set<string>>();
    for (const s of allSessions) {
      for (const c of (s.claimedFiles as Record<string, unknown>[])) {
        const p = c.path as string;
        const set = byPath.get(p) || new Set<string>();
        set.add(s.id as string);
        byPath.set(p, set);
      }
    }
    const conflicts: { path: string; sessionIds: string[] }[] = [];
    for (const [p, set] of byPath) {
      if (set.size > 1) conflicts.push({ path: p, sessionIds: [...set] });
    }

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].path, "src/auth.ts");
    assert.ok(conflicts[0].sessionIds.includes("cr_local"));
    assert.ok(conflicts[0].sessionIds.includes("cr_remote"));
  });
});
