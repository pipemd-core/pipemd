import assert from "node:assert/strict";
import { reverseInject } from "../src/core/injector.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  \x1b[31m✖\x1b[0m ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log("\x1b[1;33m═══ reverseInject Unit Tests ═══\x1b[0m\n");

test("preserves edits outside pmd blocks", () => {
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

test("cleans multiple pmd blocks", () => {
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

test("handles unknown pmd blocks not in template (creates empty)", () => {
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

test("no pmd blocks at all — passes through unchanged", () => {
  const template = "Hello world\nNo blocks here";
  const rendered = "Hello world\nNo blocks here";
  const result = reverseInject(rendered, template);
  assert.equal(result, rendered);
});

test("empty pmd blocks in rendered — preserves template format", () => {
  const template = "<!-- pmd: git-status -->\n```\n\n```\n<!-- /pmd -->";
  const rendered = "<!-- pmd: git-status -->\n```\n\n```\n<!-- /pmd -->";
  const result = reverseInject(rendered, template);
  assert.equal(result, template);
});

test("preserves edits between pmd blocks (interstitial text)", () => {
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

test("handles edits in static rules section", () => {
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

console.log("");
console.log(`\x1b[1;33m═══ Results ═══\x1b[0m`);
console.log(`  \x1b[32mPASS\x1b[0m: ${passed}`);
console.log(`  \x1b[31mFAIL\x1b[0m: ${failed}`);

if (failed > 0) {
  console.log(`\n\x1b[31m✖ reverseInject tests failed\x1b[0m`);
  process.exit(1);
} else {
  console.log(`\n\x1b[32m✔ All reverseInject tests passed\x1b[0m`);
}
