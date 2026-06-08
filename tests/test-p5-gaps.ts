import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-p5-test-"));
const linkDir = path.join(tmpDir, ".pipemd", "link");
fs.mkdirSync(linkDir, { recursive: true });

const origDir = process.cwd();
process.chdir(tmpDir);

const origHome = process.env.HOME;
process.env.HOME = tmpDir;

const testToken = "test-p5-token-12345";
fs.writeFileSync(path.join(linkDir, "relay.token"), testToken, "utf-8");

const { startRelay, stopRelay } = await import("../src/core/net/relay.js");
const { DEFAULT_ACTIVE_RULES } = await import("../src/core/injection-types.js");
const { BLOCK_SOURCES, isSharedBlock } = await import("../src/core/block-scope.js");

function post(
  port: number,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
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
    req.write(payload);
    req.end();
  });
}

function get(
  port: number,
  urlPath: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "GET" },
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
    req.end();
  });
}

describe("P5 Gap Fixes", () => {
  describe("G1 — blockStore TTL eviction", () => {
    let port: number;

    before(async () => {
      port = await startRelay(0);
    });

    after(() => {
      stopRelay();
    });

    it("evicts blocks older than 30 min and keeps recent blocks", async () => {
      const oldTs = Date.now() - 31 * 60 * 1000;
      const recentTs = Date.now();
      const group = "ttl-evict";
      const sha = "sha-ttl";

      const { status } = await post(port, "/blocks", {
        group,
        hostname: "test-host",
        commitSha: sha,
        blocks: [
          { source: "old-a", data: "stale a", timestamp: oldTs, hash: "ha" },
          { source: "old-b", data: "stale b", timestamp: oldTs, hash: "hb" },
          { source: "fresh-a", data: "fresh a", timestamp: recentTs, hash: "hc" },
          { source: "fresh-b", data: "fresh b", timestamp: recentTs, hash: "hd" },
        ],
      });
      assert.equal(status, 200);

      const { data: before } = await get(
        port,
        `/blocks?group=${group}&commitSha=${sha}`,
      );
      assert.equal(
        (before as any).blocks.length,
        4,
        "all 4 blocks present before eviction",
      );

      await new Promise((r) => setTimeout(r, 16_000));

      const { data: after } = await get(
        port,
        `/blocks?group=${group}&commitSha=${sha}`,
      );
      const blocks = (after as any).blocks as any[];
      assert.equal(blocks.length, 2, "only 2 recent blocks survive TTL eviction");
      const sources = blocks.map((b: any) => b.source).sort();
      assert.deepEqual(sources, ["fresh-a", "fresh-b"]);
    });
  });

  describe("G1 — blockStore overflow cap (BLOCK_STORE_MAX=1000)", () => {
    let port: number;

    before(async () => {
      port = await startRelay(0);
    });

    after(() => {
      stopRelay();
    });

    it("evicts oldest entries when blockStore exceeds 1000", async () => {
      const group = "cap-test";
      const sha = "sha-cap";
      const now = Date.now();
      const total = 1100;

      const blocks: Array<{
        source: string;
        data: string;
        timestamp: number;
        hash: string;
      }> = [];
      for (let i = 0; i < total; i++) {
        blocks.push({
          source: `src-${i}`,
          data: `data-${i}`,
          timestamp: now + i,
          hash: `h-${i}`,
        });
      }

      const { status } = await post(port, "/blocks", {
        group,
        hostname: "test-host",
        commitSha: sha,
        blocks,
      });
      assert.equal(status, 200);

      await new Promise((r) => setTimeout(r, 16_000));

      const { data } = await get(
        port,
        `/blocks?group=${group}&commitSha=${sha}`,
      );
      const result = (data as any).blocks as any[];
      assert.equal(result.length, 1000, "blockStore capped at 1000 entries");

      const sources = result.map((b: any) => b.source);
      assert.ok(!sources.includes("src-0"), "oldest block evicted");
      assert.ok(!sources.includes("src-99"), "100th oldest evicted");
      assert.ok(sources.includes("src-100"), "101st block survives");
      assert.ok(
        sources.includes(`src-${total - 1}`),
        "newest block survives",
      );
    });
  });

  describe("G2 — Handoff in default rules", () => {
    it("on-start includes a handoff rule", () => {
      const onStart = DEFAULT_ACTIVE_RULES.rules["on-start"];
      assert.ok(onStart, "on-start rules exist");
      const handoff = onStart!.filter((r) => r.source === "handoff");
      assert.equal(handoff.length, 1, "exactly one handoff rule in on-start");
      assert.equal(handoff[0].scope, "global");
    });

    it("on-idle includes a handoff rule", () => {
      const onIdle = DEFAULT_ACTIVE_RULES.rules["on-idle"];
      assert.ok(onIdle, "on-idle rules exist");
      const handoff = onIdle!.filter((r) => r.source === "handoff");
      assert.equal(handoff.length, 1, "exactly one handoff rule in on-idle");
      assert.equal(handoff[0].scope, "global");
    });
  });

  describe("G3 — Dynamic shared sources", () => {
    it("filtering BLOCK_SOURCES by isSharedBlock partitions correctly", () => {
      const shared = BLOCK_SOURCES.filter(isSharedBlock);
      const local = BLOCK_SOURCES.filter((s) => !isSharedBlock(s));

      assert.ok(shared.length > 0, "has shared sources");
      assert.ok(local.length > 0, "has local sources");
      assert.equal(
        shared.length + local.length,
        BLOCK_SOURCES.length,
        "shared + local = total",
      );

      for (const s of shared) {
        assert.ok(isSharedBlock(s), `${s} should be shared`);
      }
      for (const s of local) {
        assert.ok(!isSharedBlock(s), `${s} should be local`);
      }
    });

    it("handoff is in the shared list", () => {
      assert.ok(isSharedBlock("handoff"), "handoff is a shared source");
      const shared = BLOCK_SOURCES.filter(isSharedBlock);
      assert.ok(
        shared.includes("handoff"),
        "handoff appears in shared BLOCK_SOURCES",
      );
    });
  });
});

after(() => {
  process.chdir(origDir);
  process.env.HOME = origHome;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});
