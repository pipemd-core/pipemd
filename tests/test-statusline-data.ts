import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-statusline-"));
const pipemdDir = path.join(tmpDir, ".pipemd");
fs.mkdirSync(pipemdDir, { recursive: true });

const origDir = process.cwd();
process.chdir(tmpDir);

const {
  estimateTokens,
  formatTokenCount,
  bumpInjectStats,
  readInjectStats,
  shouldSuppressGeminiStatusline,
  readCrewSnapshot,
  CREW_STATUS_FILE,
  GEMINI_STATUSLINE_STATE,
} = await import("../src/core/statusline-data.js");

describe("estimateTokens", () => {
  it("divides bytes by 4 and rounds", () => {
    assert.equal(estimateTokens(100), 25);
    assert.equal(estimateTokens(103), 26);
    assert.equal(estimateTokens(0), 0);
  });

  it("handles large byte counts", () => {
    assert.equal(estimateTokens(40000), 10000);
  });
});

describe("formatTokenCount", () => {
  it("formats numbers under 1000 as-is", () => {
    assert.equal(formatTokenCount(0), "0");
    assert.equal(formatTokenCount(500), "500");
    assert.equal(formatTokenCount(999), "999");
  });

  it("formats 1000+ as k with one decimal", () => {
    assert.equal(formatTokenCount(1000), "1.0k");
    assert.equal(formatTokenCount(1500), "1.5k");
    assert.equal(formatTokenCount(10000), "10.0k");
  });
});

describe("bumpInjectStats / readInjectStats", () => {
  it("bumps delivered counter and records last event", () => {
    bumpInjectStats(pipemdDir, "delivered", { trigger: "before-read", file: "a.ts" });
    const stats = readInjectStats(pipemdDir);
    assert.equal(stats.delivered, 1);
    assert.equal(stats.dedup, 0);
    assert.ok(stats.lastEvent);
    assert.equal(stats.lastEvent!.trigger, "before-read");
    assert.equal(stats.lastEvent!.file, "a.ts");
    assert.equal(stats.lastEvent!.result, "delivered");
  });

  it("bumps dedup counter", () => {
    bumpInjectStats(pipemdDir, "dedup", { trigger: "before-edit", file: "b.ts" });
    const stats = readInjectStats(pipemdDir);
    assert.equal(stats.delivered, 1);
    assert.equal(stats.dedup, 1);
  });
});

describe("shouldSuppressGeminiStatusline", () => {
  it("returns false on first call (no prior state)", () => {
    const stateFile = path.join(pipemdDir, GEMINI_STATUSLINE_STATE);
    try { fs.unlinkSync(stateFile); } catch {}
    assert.equal(shouldSuppressGeminiStatusline(pipemdDir, "status: ok"), false);
  });

  it("returns true when same line emitted within debounce window", () => {
    const stateFile = path.join(pipemdDir, GEMINI_STATUSLINE_STATE);
    fs.writeFileSync(stateFile, JSON.stringify({ ts: Date.now(), line: "status: ok" }));
    assert.equal(shouldSuppressGeminiStatusline(pipemdDir, "status: ok"), true);
  });

  it("returns false when line is different even within window", () => {
    const stateFile = path.join(pipemdDir, GEMINI_STATUSLINE_STATE);
    fs.writeFileSync(stateFile, JSON.stringify({ ts: Date.now(), line: "status: ok" }));
    assert.equal(shouldSuppressGeminiStatusline(pipemdDir, "status: different"), false);
  });

  it("returns false when debounce window has expired", () => {
    const stateFile = path.join(pipemdDir, GEMINI_STATUSLINE_STATE);
    fs.writeFileSync(stateFile, JSON.stringify({ ts: Date.now() - 5000, line: "status: ok" }));
    assert.equal(shouldSuppressGeminiStatusline(pipemdDir, "status: ok"), false);
  });
});

describe("readCrewSnapshot", () => {
  it("returns null when no snapshot file exists", () => {
    const csFile = path.join(pipemdDir, CREW_STATUS_FILE);
    try { fs.unlinkSync(csFile); } catch {}
    assert.equal(readCrewSnapshot(pipemdDir), null);
  });

  it("returns null for snapshot without ts field", () => {
    const csFile = path.join(pipemdDir, CREW_STATUS_FILE);
    fs.writeFileSync(csFile, JSON.stringify({ sessionCount: 3 }));
    assert.equal(readCrewSnapshot(pipemdDir), null);
  });

  it("returns null for stale snapshot", () => {
    const csFile = path.join(pipemdDir, CREW_STATUS_FILE);
    fs.writeFileSync(csFile, JSON.stringify({ ts: Date.now() - 200000, sessionCount: 2 }));
    assert.equal(readCrewSnapshot(pipemdDir), null);
  });

  it("returns snapshot data for fresh file", () => {
    const csFile = path.join(pipemdDir, CREW_STATUS_FILE);
    fs.writeFileSync(csFile, JSON.stringify({
      ts: Date.now(),
      sessionCount: 3,
      conflicts: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      passiveAgents: ["agent1", "agent2"],
    }));
    const snap = readCrewSnapshot(pipemdDir);
    assert.ok(snap);
    assert.equal(snap!.sessionCount, 3);
    assert.equal(snap!.conflictPaths.length, 2);
    assert.deepEqual(snap!.conflictPaths, ["src/a.ts", "src/b.ts"]);
    assert.equal(snap!.passiveCount, 2);
  });

  it("uses sessions.length when sessionCount missing", () => {
    const csFile = path.join(pipemdDir, CREW_STATUS_FILE);
    fs.writeFileSync(csFile, JSON.stringify({
      ts: Date.now(),
      sessions: [{ id: "a" }, { id: "b" }],
      conflicts: [],
      passiveAgents: [],
    }));
    const snap = readCrewSnapshot(pipemdDir);
    assert.ok(snap);
    assert.equal(snap!.sessionCount, 2);
  });

  it("handles snapshot with no conflicts or passiveAgents fields", () => {
    const csFile = path.join(pipemdDir, CREW_STATUS_FILE);
    fs.writeFileSync(csFile, JSON.stringify({ ts: Date.now(), sessionCount: 1 }));
    const snap = readCrewSnapshot(pipemdDir);
    assert.ok(snap);
    assert.equal(snap!.sessionCount, 1);
    assert.equal(snap!.conflictPaths.length, 0);
    assert.equal(snap!.passiveCount, 0);
  });
});

after(() => {
  process.chdir(origDir);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
