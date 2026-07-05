import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  recordEdit,
  editCount,
  rewriteRate,
  sessionRewriteRate,
  clearSession,
  trackedFileCount,
  resetAll,
} from "../src/core/rewrite-tracker.js";

describe("rewrite-tracker — V15 S1 (session-scoped edit counter, R-22)", () => {
  beforeEach(() => {
    resetAll();
  });

  describe("recordEdit + editCount", () => {
    it("returns 0 for an untouched file", () => {
      assert.equal(editCount("s1", "src/foo.ts"), 0);
    });

    it("counts the first edit as 1 (file creation)", () => {
      recordEdit("s1", "src/foo.ts");
      assert.equal(editCount("s1", "src/foo.ts"), 1);
    });

    it("increments on subsequent edits", () => {
      recordEdit("s1", "src/foo.ts");
      recordEdit("s1", "src/foo.ts");
      recordEdit("s1", "src/foo.ts");
      assert.equal(editCount("s1", "src/foo.ts"), 3);
    });

    it("tracks multiple files independently within one session", () => {
      recordEdit("s1", "a.ts");
      recordEdit("s1", "a.ts");
      recordEdit("s1", "b.ts");
      assert.equal(editCount("s1", "a.ts"), 2);
      assert.equal(editCount("s1", "b.ts"), 1);
      assert.equal(editCount("s1", "c.ts"), 0);
    });

    it("is a no-op on empty sessionId or filePath (defensive)", () => {
      recordEdit("", "src/foo.ts");
      recordEdit("s1", "");
      assert.equal(editCount("s1", "src/foo.ts"), 0);
    });
  });

  describe("R-22 — session scoping (no cross-session leak)", () => {
    it("edits in one session are invisible to another", () => {
      recordEdit("alpha", "src/foo.ts");
      recordEdit("alpha", "src/foo.ts");
      recordEdit("alpha", "src/bar.ts");
      assert.equal(editCount("alpha", "src/foo.ts"), 2);
      // beta has NOT seen any edits despite same paths
      assert.equal(editCount("beta", "src/foo.ts"), 0);
      assert.equal(editCount("beta", "src/bar.ts"), 0);
    });

    it("clearSession removes ONLY that session's state", () => {
      recordEdit("alpha", "a.ts");
      recordEdit("beta", "a.ts");
      clearSession("alpha");
      assert.equal(editCount("alpha", "a.ts"), 0);
      assert.equal(editCount("beta", "a.ts"), 1);
    });

    it("resetAll wipes every session (test-only helper)", () => {
      recordEdit("alpha", "a.ts");
      recordEdit("beta", "a.ts");
      resetAll();
      assert.equal(editCount("alpha", "a.ts"), 0);
      assert.equal(editCount("beta", "a.ts"), 0);
    });

    it("a reused sessionId does NOT inherit prior counts (reset semantics)", () => {
      recordEdit("s1", "src/foo.ts");
      recordEdit("s1", "src/foo.ts");
      clearSession("s1");
      recordEdit("s1", "src/foo.ts");
      // After clear + reuse, count restarts at 1 — no stale leak.
      assert.equal(editCount("s1", "src/foo.ts"), 1);
    });
  });

  describe("rewriteRate (per-file, matches V14 rw_rw_ratio)", () => {
    it("returns 0 for an untouched file", () => {
      assert.equal(rewriteRate("s1", "src/foo.ts"), 0);
    });

    it("returns 0 after the first edit (creation, not rewrite)", () => {
      recordEdit("s1", "src/foo.ts");
      assert.equal(rewriteRate("s1", "src/foo.ts"), 0);
    });

    it("returns 0.5 after two edits (one rewrite out of two edits)", () => {
      recordEdit("s1", "src/foo.ts");
      recordEdit("s1", "src/foo.ts");
      assert.equal(rewriteRate("s1", "src/foo.ts"), 0.5);
    });

    it("returns 2/3 after three edits (two rewrites out of three)", () => {
      recordEdit("s1", "src/foo.ts");
      recordEdit("s1", "src/foo.ts");
      recordEdit("s1", "src/foo.ts");
      assert.equal(rewriteRate("s1", "src/foo.ts"), 2 / 3);
    });
  });

  describe("sessionRewriteRate (across all files in session)", () => {
    it("returns 0 for an empty session", () => {
      assert.equal(sessionRewriteRate("s1"), 0);
    });

    it("returns 0 when every file was edited exactly once", () => {
      recordEdit("s1", "a.ts");
      recordEdit("s1", "b.ts");
      recordEdit("s1", "c.ts");
      assert.equal(sessionRewriteRate("s1"), 0);
    });

    it("weights by edit count across files", () => {
      // a.ts: 3 edits → 2 rewrites
      // b.ts: 1 edit  → 0 rewrites
      // c.ts: 2 edits → 1 rewrite
      // total: 6 edits, 3 rewrites → rate 0.5
      recordEdit("s1", "a.ts");
      recordEdit("s1", "a.ts");
      recordEdit("s1", "a.ts");
      recordEdit("s1", "b.ts");
      recordEdit("s1", "c.ts");
      recordEdit("s1", "c.ts");
      assert.equal(sessionRewriteRate("s1"), 0.5);
    });

    it("does not leak across sessions", () => {
      recordEdit("alpha", "a.ts");
      recordEdit("alpha", "a.ts");
      // alpha: 2 edits, 1 rewrite → rate 0.5
      assert.equal(sessionRewriteRate("alpha"), 0.5);
      // beta is untouched
      assert.equal(sessionRewriteRate("beta"), 0);
    });
  });

  describe("trackedFileCount", () => {
    it("returns 0 for an unknown session", () => {
      assert.equal(trackedFileCount("nope"), 0);
    });

    it("returns the number of distinct files touched", () => {
      recordEdit("s1", "a.ts");
      recordEdit("s1", "a.ts");
      recordEdit("s1", "b.ts");
      assert.equal(trackedFileCount("s1"), 2);
    });
  });
});
