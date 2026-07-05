import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { topologyAllows, isProseExt } from "../src/core/topology-filter.js";

describe("topology-filter — V15 S2 (V7 15× label-spread signal as a hard gate)", () => {
  describe("topologyAllows — global sources (always allowed)", () => {
    const always = ["git-context", "git-delta", "git-staged", "git-diff-stat",
      "edit-diff", "test-failures", "crew-status", "crew-locks", "crew-todos",
      "session-diff", "handoff", "file-content", "custom", "now"] as const;

    for (const source of always) {
      it(`${source} is allowed for .ts`, () => {
        assert.equal(topologyAllows(source, "src/foo.ts"), true);
      });
      it(`${source} is allowed for .md (file-agnostic)`, () => {
        assert.equal(topologyAllows(source, "README.md"), true);
      });
      it(`${source} is allowed when no target file is given`, () => {
        assert.equal(topologyAllows(source, undefined), true);
      });
    }
  });

  describe("topologyAllows — import-graph / exports (JS/TS only)", () => {
    const jsTs = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
    const notJsTs = [".md", ".json", ".css", ".py", ".go", ".lua", ".html"];

    for (const ext of jsTs) {
      it(`import-graph allowed for ${ext}`, () => {
        assert.equal(topologyAllows("import-graph", `src/file${ext}`), true);
      });
      it(`exports allowed for ${ext}`, () => {
        assert.equal(topologyAllows("exports", `src/file${ext}`), true);
      });
    }
    for (const ext of notJsTs) {
      it(`import-graph DENIED for ${ext} (no from-imports to grep)`, () => {
        assert.equal(topologyAllows("import-graph", `src/file${ext}`), false);
      });
      it(`exports DENIED for ${ext}`, () => {
        assert.equal(topologyAllows("exports", `src/file${ext}`), false);
      });
    }
  });

  describe("topologyAllows — syntax-check (typeable only)", () => {
    const typeable = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];
    const notTypeable = [".md", ".json", ".css", ".html", ".svg", ".py"];

    for (const ext of typeable) {
      it(`syntax-check allowed for ${ext}`, () => {
        assert.equal(topologyAllows("syntax-check", `src/file${ext}`), true);
      });
    }
    for (const ext of notTypeable) {
      it(`syntax-check DENIED for ${ext} (no tsc-aware tooling)`, () => {
        assert.equal(topologyAllows("syntax-check", `src/file${ext}`), false);
      });
    }
  });

  describe("topologyAllows — file-errors (lintable)", () => {
    const lintable = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".lua"];
    const notLintable = [".md", ".json", ".css", ".html", ".svg"];

    for (const ext of lintable) {
      it(`file-errors allowed for ${ext}`, () => {
        assert.equal(topologyAllows("file-errors", `src/file${ext}`), true);
      });
    }
    for (const ext of notLintable) {
      it(`file-errors DENIED for ${ext} (no linter)`, () => {
        assert.equal(topologyAllows("file-errors", `src/file${ext}`), false);
      });
    }
  });

  describe("topologyAllows — case-insensitive extensions", () => {
    it("uppercase .TS is treated like .ts", () => {
      assert.equal(topologyAllows("syntax-check", "src/FOO.TS"), true);
      assert.equal(topologyAllows("import-graph", "src/FOO.TS"), true);
    });
    it(".MD is still denied for syntax-check", () => {
      assert.equal(topologyAllows("syntax-check", "README.MD"), false);
    });
  });

  describe("isProseExt", () => {
    it("classifies markdown/json/css as prose", () => {
      assert.equal(isProseExt(".md"), true);
      assert.equal(isProseExt(".json"), true);
      assert.equal(isProseExt(".css"), true);
    });
    it("classifies .ts as NOT prose", () => {
      assert.equal(isProseExt(".ts"), false);
    });
    it("accepts ext with or without leading dot", () => {
      assert.equal(isProseExt("md"), true);
      assert.equal(isProseExt(".md"), true);
    });
  });
});
