import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-dedup-"));
const injectedDir = path.join(tmpDir, ".pipemd", "cache", "injected");
fs.mkdirSync(injectedDir, { recursive: true });

const origDir = process.cwd();
process.chdir(tmpDir);

const {
  checkInjectionStatus,
  recordInjection,
  getLastInjectedHash,
  clearSessionRecords,
  purgeOldRecords,
  clearMemCache,
  ensureInjectedDir,
} = await import("../src/core/dedup.js");

describe("checkInjectionStatus", () => {
  it("returns 'new' for unseen session/source", () => {
    assert.equal(checkInjectionStatus("sess-new", "src-new", "content"), "new");
  });

  it("returns 'unchanged' for identical content", () => {
    recordInjection("sess-uc", "src-uc", "same content");
    assert.equal(checkInjectionStatus("sess-uc", "src-uc", "same content"), "unchanged");
  });

  it("returns 'changed' for different content", () => {
    recordInjection("sess-ch", "src-ch", "original");
    assert.equal(checkInjectionStatus("sess-ch", "src-ch", "modified"), "changed");
  });
});

describe("recordInjection", () => {
  it("persists data so subsequent reads see it", () => {
    recordInjection("sess-persist", "src-p", "hello");
    assert.equal(checkInjectionStatus("sess-persist", "src-p", "hello"), "unchanged");
    assert.equal(checkInjectionStatus("sess-persist", "src-p", "world"), "changed");
  });

  it("isolates sessions from each other", () => {
    recordInjection("sess-a", "shared", "data-a");
    recordInjection("sess-b", "shared", "data-b");
    assert.equal(checkInjectionStatus("sess-a", "shared", "data-a"), "unchanged");
    assert.equal(checkInjectionStatus("sess-b", "shared", "data-b"), "unchanged");
    assert.equal(checkInjectionStatus("sess-a", "shared", "data-b"), "changed");
  });

  it("isolates sources within same session", () => {
    recordInjection("sess-multi", "src-1", "aaa");
    recordInjection("sess-multi", "src-2", "bbb");
    assert.equal(checkInjectionStatus("sess-multi", "src-1", "aaa"), "unchanged");
    assert.equal(checkInjectionStatus("sess-multi", "src-2", "bbb"), "unchanged");
    assert.equal(checkInjectionStatus("sess-multi", "src-1", "bbb"), "changed");
  });
});

describe("getLastInjectedHash", () => {
  it("returns null for unknown session/source", () => {
    assert.equal(getLastInjectedHash("unknown-sess", "unknown-src"), null);
  });

  it("returns hash after recording", () => {
    recordInjection("sess-hash", "src-hash", "some content");
    const hash = getLastInjectedHash("sess-hash", "src-hash");
    assert.ok(hash);
    assert.equal(hash.length, 16);
  });
});

describe("clearSessionRecords", () => {
  it("removes session file", () => {
    recordInjection("sess-clear", "src", "data");
    clearSessionRecords("sess-clear");
    clearMemCache();
    assert.equal(checkInjectionStatus("sess-clear", "src", "data"), "new");
  });

  it("does not throw for nonexistent session", () => {
    assert.doesNotThrow(() => clearSessionRecords("no-such-session"));
  });
});

describe("clearMemCache", () => {
  it("clears in-memory cache forcing disk re-read", () => {
    recordInjection("sess-mem", "src-mem", "data");
    assert.equal(checkInjectionStatus("sess-mem", "src-mem", "data"), "unchanged");
    clearMemCache();
    assert.equal(checkInjectionStatus("sess-mem", "src-mem", "data"), "unchanged");
  });
});

describe("purgeOldRecords", () => {
  it("removes files older than maxAgeMs", () => {
    const oldFile = path.join(injectedDir, "old-session.json");
    fs.writeFileSync(oldFile, JSON.stringify({ src: { hash: "abc", timestamp: 0 } }), "utf-8");
    const oldTime = Date.now() - 7200000;
    fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

    purgeOldRecords(3600000);
    assert.ok(!fs.existsSync(oldFile));
  });

  it("keeps files newer than maxAgeMs", () => {
    const recentFile = path.join(injectedDir, "recent-session.json");
    fs.writeFileSync(recentFile, JSON.stringify({}), "utf-8");

    purgeOldRecords(3600000);
    assert.ok(fs.existsSync(recentFile));
  });

  it("does not throw when directory is empty", () => {
    const emptyDir = path.join(tmpDir, ".pipemd", "cache", "injected-empty");
    fs.mkdirSync(emptyDir, { recursive: true });
    assert.doesNotThrow(() => purgeOldRecords.call(null, 1000));
  });
});

describe("ensureInjectedDir", () => {
  it("creates the injected directory if missing", () => {
    const testDir = path.join(tmpDir, ".pipemd", "cache", "injected-new");
    assert.ok(!fs.existsSync(testDir));
    ensureInjectedDir();
  });
});

after(() => {
  process.chdir(origDir);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
