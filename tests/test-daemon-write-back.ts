import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-write-back-"));
const pipemdDir = path.join(tmpDir, ".pipemd");
fs.mkdirSync(pipemdDir, { recursive: true });

const origDir = process.cwd();
process.chdir(tmpDir);

const { loadBase, composeContent, splitContextContent, handleIncomingWrite } = await import("../src/core/daemon-write-back.js");
const { injectContent } = await import("../src/core/injector.js");

const makeConfig = (base?: string) => ({
  version: "1.0",
  commands: { echo: "echo hello" } as Record<string, string>,
  injected: [{ file: ".pipemd/template.md", watch: true }],
  pipes: [],
  settings: { debounceMs: 3000, reServeDelayMs: 1000 },
  ...(base !== undefined ? { base } : {}),
});

describe("loadBase", () => {
  it("returns empty string when config has no base", () => {
    assert.equal(loadBase(makeConfig()), "");
  });

  it("returns empty string when config.base is undefined", () => {
    assert.equal(loadBase(makeConfig(undefined)), "");
  });

  it("reads and trims the base file", () => {
    const baseFile = path.join(pipemdDir, "base.md");
    fs.writeFileSync(baseFile, "  Hello base  \n\n  ", "utf-8");
    assert.equal(loadBase(makeConfig(baseFile)), "  Hello base");
  });

  it("returns empty for missing base file path", () => {
    assert.equal(loadBase(makeConfig(path.join(pipemdDir, "nonexistent.md"))), "");
  });
});

describe("composeContent", () => {
  it("returns renderedTemplate when base is empty", () => {
    assert.equal(composeContent("", "template"), "template");
  });

  it("joins base and template with separator", () => {
    const result = composeContent("base content", "template content");
    assert.ok(result.includes("base content"));
    assert.ok(result.includes("template content"));
    assert.ok(result.includes("<!-- pmd-context -->"));
    assert.ok(result.includes("---"));
  });

  it("places base before separator and template after", () => {
    const result = composeContent("AAA", "BBB");
    const baseIdx = result.indexOf("AAA");
    const sepIdx = result.indexOf("<!-- pmd-context -->");
    const tplIdx = result.indexOf("BBB");
    assert.ok(baseIdx < sepIdx);
    assert.ok(sepIdx < tplIdx);
  });
});

describe("splitContextContent", () => {
  it("splits on separator with base content", () => {
    const content = "base stuff\n\n---\n\n<!-- pmd-context -->\ntemplate stuff";
    const { base, template } = splitContextContent(content);
    assert.equal(base, "base stuff");
    assert.equal(template, "template stuff");
  });

  it("returns all as template when no separator present", () => {
    const content = "just template content here";
    const { base, template } = splitContextContent(content);
    assert.equal(base, "");
    assert.equal(template, content);
  });

  it("handles separator with no base content before it", () => {
    const content = "<!-- pmd-context -->\ntemplate only";
    const { base, template } = splitContextContent(content);
    assert.equal(base, "");
    assert.equal(template, "template only");
  });

  it("strips trailing --- from base before separator", () => {
    const content = "base info\n---\n<!-- pmd-context -->\ntemplate";
    const { base, template } = splitContextContent(content);
    assert.equal(base, "base info");
    assert.equal(template, "template");
  });

  it("handles multi-line base content", () => {
    const content = "line1\nline2\nline3\n\n---\n\n<!-- pmd-context -->\ntpl";
    const { base, template } = splitContextContent(content);
    assert.equal(base, "line1\nline2\nline3");
    assert.equal(template, "tpl");
  });
});

describe("handleIncomingWrite", () => {
  it("skips when writeBackInProgress is true", () => {
    const templatePath = path.join(pipemdDir, "template-skip.md");
    fs.writeFileSync(templatePath, "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->", "utf-8");
    const guard = { value: true };
    handleIncomingWrite("anything", templatePath, makeConfig(), guard);
    assert.equal(guard.value, true);
  });

  it("updates template when rendered content differs", () => {
    const templatePath = path.join(pipemdDir, "template-write.md");
    const templateContent = "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->";
    fs.writeFileSync(templatePath, templateContent, "utf-8");

    const renderedContent = "<!-- pmd: echo -->\n```\nhello\n```\n<!-- /pmd -->";
    const guard = { value: false };
    handleIncomingWrite(renderedContent, templatePath, makeConfig(), guard);

    const after = fs.readFileSync(templatePath, "utf-8");
    assert.equal(after, templateContent);
    assert.equal(guard.value, false);
  });

  it("resets writeBackInProgress to false after processing", () => {
    const templatePath = path.join(pipemdDir, "template-reset.md");
    fs.writeFileSync(templatePath, "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->", "utf-8");
    const guard = { value: false };
    handleIncomingWrite("some data", templatePath, makeConfig(), guard);
    assert.equal(guard.value, false);
  });

  it("updates base file when base content changes", () => {
    const baseFile = path.join(pipemdDir, "base-wb.md");
    fs.writeFileSync(baseFile, "original base\n", "utf-8");
    const templatePath = path.join(pipemdDir, "template-wb.md");
    fs.writeFileSync(templatePath, "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->", "utf-8");

    const newContent = "updated base\n\n---\n\n<!-- pmd-context -->\n<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->";
    const config = makeConfig(baseFile);
    const guard = { value: false };
    handleIncomingWrite(newContent, templatePath, config, guard);

    const updatedBase = fs.readFileSync(baseFile, "utf-8");
    assert.ok(updatedBase.includes("updated base"));
  });
});

after(() => {
  process.chdir(origDir);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
