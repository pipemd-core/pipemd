import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reverseInject } from "../src/core/injector.js";

describe("reverseInject", () => {
  it("preserves edits outside pmd blocks", () => {
    const template = [
      "## Static Rules & Notes",
      "",
      "- Prefer reading <!-- pmd: --> blocks over running shell commands",
      "",
      "<!-- pmd: tree -->",
      "```",
      "",
      "```",
      "<!-- /pmd -->",
    ].join("\n");

    const rendered = [
      "## Static Rules & Notes",
      "",
      "- ALWAYS prefer reading <!-- pmd: --> blocks over running shell commands",
      "",
      "<!-- pmd: tree -->",
      "```",
      "src/",
      "  index.ts",
      "```",
      "<!-- /pmd -->",
    ].join("\n");

    const result = reverseInject(rendered, template);
    assert.ok(result.includes("ALWAYS prefer reading"), `Should preserve rule edit. Got:\n${result}`);
    assert.ok(!result.includes("src/"), "Should strip live data from pmd blocks");
    assert.ok(result.includes("<!-- pmd: tree -->"), "Should keep pmd tags");
  });

  it("cleans multiple pmd blocks", () => {
    const template = [
      "<!-- pmd: tree -->",
      "```",
      "",
      "```",
      "<!-- /pmd -->",
      "<!-- pmd: deps -->",
      "```",
      "",
      "```",
      "<!-- /pmd -->",
    ].join("\n");

    const rendered = [
      "<!-- pmd: tree -->",
      "```",
      "src/",
      "```",
      "<!-- /pmd -->",
      "<!-- pmd: deps -->",
      "```",
      "react",
      "```",
      "<!-- /pmd -->",
    ].join("\n");

    const result = reverseInject(rendered, template);
    assert.ok(!result.includes("src/"), "Should strip tree data");
    assert.ok(!result.includes("react"), "Should strip deps data");
    assert.ok(result.includes("<!-- pmd: tree -->"), "Should keep tree tag");
    assert.ok(result.includes("<!-- pmd: deps -->"), "Should keep deps tag");
  });

  it("handles unknown pmd blocks not in template (creates empty)", () => {
    const template = "<!-- pmd: tree -->\n```\n\n```\n<!-- /pmd -->";
    const rendered = [
      "<!-- pmd: tree -->",
      "```",
      "src/",
      "```",
      "<!-- /pmd -->",
      "",
      "<!-- pmd: new-block -->",
      "```",
      "data",
      "```",
      "<!-- /pmd -->",
    ].join("\n");

    const result = reverseInject(rendered, template);
    assert.ok(result.includes("<!-- pmd: new-block -->"), "Should keep unknown block tag");
    assert.ok(!result.match(/new-block[\s\S]*?data/), "Should strip unknown block content");
    assert.ok(result.includes("<!-- pmd: tree -->\n```\n\n```\n<!-- /pmd -->"), "Should restore known block to template form");
  });

  it("passes through unchanged when no pmd blocks", () => {
    const template = "Hello world\nNo blocks here";
    const rendered = "Hello world\nNo blocks here";
    const result = reverseInject(rendered, template);
    assert.equal(result, rendered);
  });

  it("preserves template format with empty pmd blocks", () => {
    const template = "<!-- pmd: git-status -->\n```\n\n```\n<!-- /pmd -->";
    const rendered = "<!-- pmd: git-status -->\n```\n\n```\n<!-- /pmd -->";
    const result = reverseInject(rendered, template);
    assert.equal(result, template);
  });

  it("preserves edits between pmd blocks (interstitial text)", () => {
    const template = [
      "Header",
      "<!-- pmd: tree -->",
      "```",
      "",
      "```",
      "<!-- /pmd -->",
      "Middle text",
      "<!-- pmd: deps -->",
      "```",
      "",
      "```",
      "<!-- /pmd -->",
      "Footer",
    ].join("\n");

    const rendered = [
      "Header",
      "<!-- pmd: tree -->",
      "```",
      "src/",
      "```",
      "<!-- /pmd -->",
      "EDITED Middle text here!!!",
      "<!-- pmd: deps -->",
      "```",
      "react",
      "```",
      "<!-- /pmd -->",
      "EDITED Footer here!!!",
    ].join("\n");

    const result = reverseInject(rendered, template);
    assert.ok(result.includes("EDITED Middle text here!!!"), "Should preserve edit between blocks");
    assert.ok(result.includes("EDITED Footer here!!!"), "Should preserve edit after blocks");
    assert.ok(!result.includes("src/"), "Should strip tree data");
    assert.ok(!result.includes("react"), "Should strip deps data");
  });

  it("handles edits in static rules section", () => {
    const template = [
      "## Static Rules & Notes",
      "",
      "- Never edit inside <!-- pmd: --> blocks",
      "- Edit freely outside <!-- pmd: --> blocks",
      "",
      "<!-- pmd: git-log -->",
      "```",
      "",
      "```",
      "<!-- /pmd -->",
    ].join("\n");

    const rendered = [
      "## Static Rules & Notes",
      "",
      "- NEVER edit inside <!-- pmd: --> blocks — your changes will be lost",
      "- Edit freely outside <!-- pmd: --> blocks — your changes persist",
      "- Always run tests before committing",
      "",
      "<!-- pmd: git-log -->",
      "```",
      "abc123 fix bug",
      "```",
      "<!-- /pmd -->",
    ].join("\n");

    const result = reverseInject(rendered, template);
    assert.ok(result.includes("NEVER edit inside"), "Should preserve emphasized rule");
    assert.ok(result.includes("your changes persist"), "Should preserve added emphasis");
    assert.ok(result.includes("Always run tests before committing"), "Should preserve new rule");
    assert.ok(!result.includes("abc123"), "Should strip live git-log data");
  });
});
