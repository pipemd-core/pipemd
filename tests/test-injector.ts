import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-injector-"));
const pipemdDir = path.join(tmpDir, ".pipemd");
fs.mkdirSync(pipemdDir, { recursive: true });

const origDir = process.cwd();
process.chdir(tmpDir);

const { injectContent, injectFile, renderContentAsync, reverseInject } = await import("../src/core/injector.js");

const makeConfig = (commands: Record<string, string> = {}) => ({
  version: "1.0",
  commands,
  injected: [{ file: ".pipemd/template.md", watch: true }],
  pipes: [],
  settings: { debounceMs: 3000, reServeDelayMs: 1000 },
});

describe("injectContent", () => {
  it("returns null when no commands match", () => {
    const content = "<!-- pmd: unknown -->\n```\n\n```\n<!-- /pmd -->";
    assert.equal(injectContent(content, makeConfig()), null);
  });

  it("returns null for content with no pmd blocks", () => {
    assert.equal(injectContent("plain text", makeConfig({ echo: "echo hi" })), null);
  });

  it("replaces a single block with command output", () => {
    const content = "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->";
    const result = injectContent(content, makeConfig({ echo: "echo hello world" }));
    assert.ok(result);
    assert.ok(result!.includes("hello world"));
    assert.ok(result!.includes("<!-- pmd: echo -->"));
    assert.ok(result!.includes("<!-- /pmd -->"));
  });

  it("replaces multiple blocks independently", () => {
    const content = [
      "<!-- pmd: a -->\n```\n\n```\n<!-- /pmd -->",
      "<!-- pmd: b -->\n```\n\n```\n<!-- /pmd -->",
    ].join("\n");
    const result = injectContent(content, makeConfig({ a: "echo aaa", b: "echo bbb" }));
    assert.ok(result);
    assert.ok(result!.includes("aaa"));
    assert.ok(result!.includes("bbb"));
  });

  it("collapses a failing command block (no error leaks into context)", () => {
    const content = "<!-- pmd: bad -->\n```\n\n```\n<!-- /pmd -->";
    const result = injectContent(content, makeConfig({ bad: "false" }));
    assert.notEqual(result, null, "expected a change (block should collapse)");
    assert.ok(!result!.includes("PipeMD Error"), "error string leaked into context");
    assert.ok(!result!.includes("bad"), "block tag should be collapsed, not rendered");
  });

  it("collapses a command that returns empty output (no empty code-block noise)", () => {
    const content = "<!-- pmd: empty -->\n```\n\n```\n<!-- /pmd -->";
    const result = injectContent(content, makeConfig({ empty: "true" }));
    assert.notEqual(result, null, "empty output should collapse the block (a change)");
    assert.ok(!result!.includes("<!-- pmd: empty"), "empty-output block should be removed");
  });

  it("preserves content outside blocks", () => {
    const content = "before\n<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->\nafter";
    const result = injectContent(content, makeConfig({ echo: "echo hi" }));
    assert.ok(result);
    assert.ok(result!.startsWith("before"));
    assert.ok(result!.includes("after"));
  });

  it("returns null when block content is already current", () => {
    const config = makeConfig({ echo: "echo hello" });
    const first = injectContent("<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->", config);
    assert.ok(first);
    const second = injectContent(first!, config);
    assert.equal(second, null);
  });
});

describe("injectFile", () => {
  it("writes injected content to the same file", () => {
    const filePath = path.join(tmpDir, "test-inject.md");
    fs.writeFileSync(filePath, "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->", "utf-8");
    const changed = injectFile(filePath, makeConfig({ echo: "echo injected" }));
    assert.equal(changed, true);
    const content = fs.readFileSync(filePath, "utf-8");
    assert.ok(content.includes("injected"));
  });

  it("returns false when nothing changes", () => {
    const filePath = path.join(tmpDir, "test-noop.md");
    fs.writeFileSync(filePath, "<!-- pmd: unknown -->\n```\n\n```\n<!-- /pmd -->", "utf-8");
    assert.equal(injectFile(filePath, makeConfig()), false);
  });

  it("writes to outputPath when specified", () => {
    const srcPath = path.join(tmpDir, "src.md");
    const outPath = path.join(tmpDir, "out.md");
    fs.writeFileSync(srcPath, "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->", "utf-8");
    injectFile(srcPath, makeConfig({ echo: "echo output" }), outPath);
    const content = fs.readFileSync(outPath, "utf-8");
    assert.ok(content.includes("output"));
  });
});

describe("renderContentAsync", () => {
  it("returns template unchanged when no pmd tags", async () => {
    const result = await renderContentAsync("no tags here", makeConfig());
    assert.equal(result, "no tags here");
  });

  it("replaces blocks with async command output", async () => {
    const template = "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->";
    const result = await renderContentAsync(template, makeConfig({ echo: "echo async-result" }));
    assert.ok(result.includes("async-result"));
    assert.ok(result.includes("<!-- pmd: echo -->"));
  });

  it("handles missing commands by returning empty string for tag", async () => {
    const template = "<!-- pmd: missing -->\n```\nold\n```\n<!-- /pmd -->";
    const result = await renderContentAsync(template, makeConfig());
    assert.ok(!result.includes("missing"));
    assert.ok(!result.includes("old"));
  });

  it("collapses a failing async command (no error leaks into context)", async () => {
    const template = "<!-- pmd: bad -->\n```\n\n```\n<!-- /pmd -->";
    const result = await renderContentAsync(template, makeConfig({ bad: "false" }));
    assert.ok(!result.includes("PipeMD Error"), "error string leaked into context");
    assert.ok(!result.includes("bad"), "block tag should be collapsed, not rendered");
  });

  it("truncates output when maxLines is exceeded", async () => {
    const template = "<!-- pmd: seq -->\n```\n\n```\n<!-- /pmd -->";
    const result = await renderContentAsync(
      template,
      makeConfig({ seq: "seq 1 20" }),
      5,
    );
    const lines = result.split("\n");
    assert.ok(lines.length <= 10);
    assert.ok(result.includes("truncated"));
  });

  it("does not truncate when within maxLines", async () => {
    const template = "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->";
    const result = await renderContentAsync(
      template,
      makeConfig({ echo: "echo short" }),
      100,
    );
    assert.ok(!result.includes("truncated"));
  });

  it("runs multiple commands in parallel", async () => {
    const template = [
      "<!-- pmd: a -->\n```\n\n```\n<!-- /pmd -->",
      "<!-- pmd: b -->\n```\n\n```\n<!-- /pmd -->",
    ].join("\n");
    const result = await renderContentAsync(template, makeConfig({ a: "echo aa", b: "echo bb" }));
    assert.ok(result.includes("aa"));
    assert.ok(result.includes("bb"));
  });

  it("serves slow blocks from cache between slow ticks (fast ticks don't re-run them)", async () => {
    const src = path.join(tmpDir, "slow-source.txt");
    fs.writeFileSync(src, "A");
    const template = "<!-- pmd: slow -->\n```\n\n```\n<!-- /pmd -->";
    const cfg = makeConfig({ slow: `cat ${src}` });
    const slowNames = new Set(["slow"]);
    const slowResults = new Map<string, string>();
    // First call: cache miss → slow block runs and is cached.
    const first = await renderContentAsync(template, cfg, undefined, slowNames, slowResults);
    assert.ok(first.includes("A"), "first render should see A");
    assert.ok(slowResults.has("slow"), "slow block result should be cached after first run");
    // Change the source — a fast tick must NOT see it (served from cache).
    fs.writeFileSync(src, "B");
    const second = await renderContentAsync(template, cfg, undefined, slowNames, slowResults);
    assert.ok(second.includes("A") && !second.includes("B"), "fast tick must serve cached slow output, not re-run");
    // After a slow tick clears the cache, the slow block re-runs and sees B.
    slowResults.clear();
    const third = await renderContentAsync(template, cfg, undefined, slowNames, slowResults);
    assert.ok(third.includes("B"), "after cache clear (slow tick), slow block must re-run");
  });
});

describe("reverseInject", () => {
  it("restores template blocks from rendered content", () => {
    const template = "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->";
    const rendered = "<!-- pmd: echo -->\n```\nhello\n```\n<!-- /pmd -->";
    assert.equal(reverseInject(rendered, template), template);
  });

  it("creates empty block for tags not in template", () => {
    const template = "<!-- pmd: a -->\n```\n\n```\n<!-- /pmd -->";
    const rendered = "<!-- pmd: a -->\n```\ndata\n```\n<!-- /pmd -->\n<!-- pmd: b -->\n```\nextra\n```\n<!-- /pmd -->";
    const result = reverseInject(rendered, template);
    assert.ok(result.includes("<!-- pmd: b -->"));
    assert.ok(!result.includes("extra"));
  });

  it("preserves content between blocks", () => {
    const template = "X\n<!-- pmd: a -->\n```\n\n```\n<!-- /pmd -->\nY";
    const rendered = "X\n<!-- pmd: a -->\n```\ndata\n```\n<!-- /pmd -->\nY";
    const result = reverseInject(rendered, template);
    assert.ok(result.startsWith("X"));
    assert.ok(result.endsWith("Y"));
  });

  it("returns input unchanged when no blocks present", () => {
    const content = "no blocks at all";
    assert.equal(reverseInject(content, content), content);
  });
});

after(() => {
  process.chdir(origDir);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
