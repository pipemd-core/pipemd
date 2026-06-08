import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBlockScope, isSharedBlock, getAllBlockScopes } from "../src/core/block-scope.js";

describe("getBlockScope", () => {
  it("returns 'shared' for shared sources", () => {
    assert.equal(getBlockScope("test-failures"), "shared");
    assert.equal(getBlockScope("git-delta"), "shared");
    assert.equal(getBlockScope("git-diff-stat"), "shared");
    assert.equal(getBlockScope("git-staged"), "shared");
    assert.equal(getBlockScope("context-rules"), "shared");
  });

  it("returns 'local' for local sources", () => {
    assert.equal(getBlockScope("syntax-check"), "local");
    assert.equal(getBlockScope("edit-diff"), "local");
    assert.equal(getBlockScope("file-errors"), "local");
    assert.equal(getBlockScope("crew-status"), "local");
    assert.equal(getBlockScope("crew-locks"), "local");
    assert.equal(getBlockScope("crew-todos"), "local");
    assert.equal(getBlockScope("git-context"), "local");
    assert.equal(getBlockScope("custom"), "local");
    assert.equal(getBlockScope("import-graph"), "local");
    assert.equal(getBlockScope("session-diff"), "local");
    assert.equal(getBlockScope("exports"), "local");
  });

  it("returns 'local' for unknown sources", () => {
    assert.equal(getBlockScope("nonexistent"), "local");
    assert.equal(getBlockScope(""), "local");
  });
});

describe("isSharedBlock", () => {
  it("returns true for shared sources", () => {
    assert.ok(isSharedBlock("test-failures"));
    assert.ok(isSharedBlock("git-delta"));
    assert.ok(isSharedBlock("context-rules"));
  });

  it("returns false for local sources", () => {
    assert.ok(!isSharedBlock("syntax-check"));
    assert.ok(!isSharedBlock("crew-status"));
    assert.ok(!isSharedBlock("custom"));
  });

  it("returns false for unknown sources", () => {
    assert.ok(!isSharedBlock("unknown"));
  });
});

describe("getAllBlockScopes", () => {
  it("returns a complete scope map", () => {
    const scopes = getAllBlockScopes();
    assert.equal(Object.keys(scopes).length, 17);
    let shared = 0;
    let local = 0;
    for (const v of Object.values(scopes)) {
      if (v === "shared") shared++;
      else local++;
    }
    assert.equal(shared, 6);
    assert.equal(local, 11);
  });

  it("returns a copy (mutations do not affect source)", () => {
    const a = getAllBlockScopes();
    a["test-failures"] = "local";
    const b = getAllBlockScopes();
    assert.equal(b["test-failures"], "shared");
  });
});
