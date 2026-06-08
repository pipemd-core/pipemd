import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-cache-test-"));
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "sources"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "validation"), { recursive: true });

const origDir = process.cwd();
process.chdir(tmpDir);

const {
  readCache,
  writeCache,
  isFresh,
  invalidate,
  invalidateCachePattern,
  CACHE_DIR,
  VALIDATION_DIR,
  ensureCacheDir,
} = await import("../src/core/cache.js");

after(() => {
  process.chdir(origDir);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("writeCache + readCache", () => {
  it("writes and reads back data", () => {
    const entry = writeCache("test-basic", "hello world", 60000);
    assert.equal(entry.data, "hello world");
    assert.ok(entry.hash);
    assert.ok(entry.timestamp > 0);

    const read = readCache("test-basic");
    assert.ok(read);
    assert.equal(read!.data, "hello world");
    assert.equal(read!.hash, entry.hash);
  });

  it("returns null for non-existent key", () => {
    assert.equal(readCache("nonexistent-key-xyz"), null);
  });

  it("overwrites existing key", () => {
    writeCache("test-overwrite", "first", 60000);
    writeCache("test-overwrite", "second", 60000);
    const read = readCache("test-overwrite");
    assert.ok(read);
    assert.equal(read!.data, "second");
  });

  it("stores metadata", () => {
    writeCache("test-meta", "data", 60000, { commitSha: "abc123" });
    const read = readCache("test-meta");
    assert.ok(read);
    assert.equal(read!.metadata!.commitSha, "abc123");
  });
});

describe("TTL expiry", () => {
  it("returns null for expired entries", () => {
    writeCache("test-expired", "old data", 1);
    const start = Date.now();
    while (Date.now() - start < 10) {}
    assert.equal(readCache("test-expired"), null);
  });

  it("returns data for non-expired entries", () => {
    writeCache("test-fresh", "fresh data", 60000);
    const read = readCache("test-fresh");
    assert.ok(read);
    assert.equal(read!.data, "fresh data");
  });
});

describe("isFresh", () => {
  it("returns true for fresh entries", () => {
    writeCache("test-isfresh", "data", 60000);
    assert.equal(isFresh("test-isfresh"), true);
  });

  it("returns false for missing entries", () => {
    assert.equal(isFresh("missing-isfresh"), false);
  });

  it("returns false for expired entries", () => {
    writeCache("test-isfresh-exp", "data", 1);
    const start = Date.now();
    while (Date.now() - start < 10) {}
    assert.equal(isFresh("test-isfresh-exp"), false);
  });
});

describe("invalidate", () => {
  it("removes a cache entry", () => {
    writeCache("test-invalidate", "data", 60000);
    assert.ok(readCache("test-invalidate"));
    invalidate("test-invalidate");
    assert.equal(readCache("test-invalidate"), null);
  });

  it("does not throw for non-existent key", () => {
    assert.doesNotThrow(() => invalidate("nonexistent-inval"));
  });
});

describe("invalidateCachePattern", () => {
  it("invalidates entries matching pattern", () => {
    writeCache("pattern-foo", "data1", 60000);
    writeCache("pattern-bar", "data2", 60000);
    writeCache("other-baz", "data3", 60000);

    const count = invalidateCachePattern("pattern");
    assert.ok(count >= 2);
    assert.equal(readCache("pattern-foo"), null);
    assert.equal(readCache("pattern-bar"), null);
    assert.ok(readCache("other-baz"));
  });

  it("returns 0 when no entries match", () => {
    const count = invalidateCachePattern("no-match-xyz");
    assert.equal(count, 0);
  });
});

describe("validation directory", () => {
  it("stores validation entries separately", () => {
    writeCache("validation:test-file", "no errors", 60000);
    const read = readCache("validation:test-file");
    assert.ok(read);
    assert.equal(read!.data, "no errors");
  });

  it("invalidates validation entries", () => {
    writeCache("validation:test-inval", "data", 60000);
    invalidate("validation:test-inval");
    assert.equal(readCache("validation:test-inval"), null);
  });
});

describe("ensureCacheDir", () => {
  it("does not throw when directories exist", () => {
    assert.doesNotThrow(() => ensureCacheDir());
  });
});
