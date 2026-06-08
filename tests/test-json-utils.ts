import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-json-utils-"));
const origDir = process.cwd();
process.chdir(tmpDir);
fs.mkdirSync(path.join(tmpDir, ".pipemd"), { recursive: true });

const { tryReadJson, isPidAlive, readInjectStats, formatTimeAgo } = await import("../src/core/json-utils.js");

describe("formatTimeAgo", () => {
  it("returns seconds for recent timestamps", () => {
    const fiveSecondsAgo = new Date(Date.now() - 5_000).toISOString();
    const result = formatTimeAgo(fiveSecondsAgo);
    assert.ok(result.endsWith("s"));
    assert.ok(parseInt(result) >= 4);
  });

  it("returns minutes for older timestamps", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = formatTimeAgo(fiveMinAgo);
    assert.ok(result.endsWith("m"));
    assert.equal(parseInt(result), 5);
  });

  it("returns hours for timestamps hours ago", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    const result = formatTimeAgo(threeHoursAgo);
    assert.ok(result.endsWith("h"));
    assert.equal(parseInt(result), 3);
  });

  it("returns days for timestamps days ago", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();
    const result = formatTimeAgo(twoDaysAgo);
    assert.ok(result.endsWith("d"));
    assert.equal(parseInt(result), 2);
  });

  it("returns 'just now' for future timestamps", () => {
    const future = new Date(Date.now() + 10_000).toISOString();
    assert.equal(formatTimeAgo(future), "just now");
  });

  it("handles 0 seconds ago", () => {
    const now = new Date().toISOString();
    const result = formatTimeAgo(now);
    assert.ok(result === "0s" || result.endsWith("s"));
  });
});

describe("tryReadJson", () => {
  it("returns parsed JSON from a valid file", () => {
    const filePath = path.join(tmpDir, "valid.json");
    fs.writeFileSync(filePath, JSON.stringify({ name: "test", value: 42 }));
    const result = tryReadJson(filePath);
    assert.equal(result?.name, "test");
    assert.equal(result?.value, 42);
  });

  it("returns null for missing file", () => {
    const result = tryReadJson(path.join(tmpDir, "nonexistent.json"));
    assert.equal(result, null);
  });

  it("returns null for invalid JSON", () => {
    const filePath = path.join(tmpDir, "invalid.json");
    fs.writeFileSync(filePath, "{{invalid}");
    const result = tryReadJson(filePath);
    assert.equal(result, null);
  });
});

describe("isPidAlive", () => {
  it("returns true for current process PID", () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it("returns false for invalid PIDs", () => {
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-1), false);
  });

  it("returns false for very high unused PID", () => {
    assert.equal(isPidAlive(999999999), false);
  });
});

describe("readInjectStats", () => {
  it("returns defaults when stats file missing", () => {
    const result = readInjectStats(path.join(tmpDir, "no-stats.json"));
    assert.equal(result.delivered, 0);
    assert.equal(result.dedup, 0);
    assert.equal(result.lastEvent, undefined);
  });

  it("returns stored values from valid file", () => {
    const filePath = path.join(tmpDir, "stats.json");
    fs.writeFileSync(filePath, JSON.stringify({
      delivered: 10,
      dedup: 3,
      lastEvent: { trigger: "before-read", file: "a.ts" },
    }));
    const result = readInjectStats(filePath);
    assert.equal(result.delivered, 10);
    assert.equal(result.dedup, 3);
    assert.ok(result.lastEvent);
  });

  it("returns defaults for file with non-numeric fields", () => {
    const filePath = path.join(tmpDir, "bad-stats.json");
    fs.writeFileSync(filePath, JSON.stringify({ delivered: "not-a-number" }));
    const result = readInjectStats(filePath);
    assert.equal(result.delivered, 0);
    assert.equal(result.dedup, 0);
  });
});

after(() => {
  process.chdir(origDir);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
