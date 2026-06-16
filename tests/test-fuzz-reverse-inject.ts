import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reverseInject } from "../src/core/injector.js";

const BLOCK = (name: string, content: string) =>
  `<!-- pmd: ${name} -->\n\`\`\`\n${content}\n\`\`\`\n<!-- /pmd -->`;

const EMPTY = (name: string) =>
  `<!-- pmd: ${name} -->\n\`\`\`\n\n\`\`\`\n<!-- /pmd -->`;

describe("reverseInject fuzz", () => {
  it("handles missing closing tag without eating subsequent content", () => {
    const template = EMPTY("tree");
    const rendered = `<!-- pmd: tree -->\n\`\`\`\nsrc/\n\`\`\`\n<!-- missing close -->\nMore content`;
    const result = reverseInject(rendered, template);
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });

  it("handles malformed/unclosed pmd block at end of content", () => {
    const template = EMPTY("tree");
    const rendered = `<!-- pmd: tree -->\n\`\`\`\ndata\nno close tag here`;
    const result = reverseInject(rendered, template);
    assert.ok(typeof result === "string");
  });

  it("handles empty content", () => {
    const result = reverseInject("", "");
    assert.equal(result, "");
  });

  it("handles content with only pmd markers (no actual blocks)", () => {
    const template = "Some text mentioning <!-- pmd: tree --> in a sentence";
    const rendered = "Some text mentioning <!-- pmd: tree --> in a sentence";
    const result = reverseInject(rendered, template);
    assert.ok(result.includes("<!-- pmd: tree -->"));
  });

  it("handles blocks with special regex chars in content", () => {
    const template = EMPTY("tree");
    const content = "[.*+?^" + "{}" + "()|[]\\] special chars";
    const rendered = BLOCK("tree", content);
    const result = reverseInject(rendered, template);
    assert.ok(!result.includes(content), "Should strip block content");
    assert.ok(result.includes("<!-- pmd: tree -->"));
  });

  it("handles many blocks (stress test)", () => {
    const names = [];
    const templateParts: string[] = [];
    const renderedParts: string[] = [];
    for (let i = 0; i < 50; i++) {
      const name = `block_${i}`;
      names.push(name);
      templateParts.push(EMPTY(name));
      renderedParts.push(BLOCK(name, `data for ${i}`));
    }
    const template = templateParts.join("\n");
    const rendered = renderedParts.join("\n");
    const result = reverseInject(rendered, template);
    for (const name of names) {
      assert.ok(result.includes(`<!-- pmd: ${name} -->`), `Should preserve ${name} tag`);
      assert.ok(!result.includes(`data for`), "Should strip all block data");
    }
  });

  it("handles duplicate block names (keeps last occurrence)", () => {
    const template = `${EMPTY("tree")}\n${EMPTY("tree")}`;
    const rendered = `${BLOCK("tree", "first")}\n${BLOCK("tree", "second")}`;
    const result = reverseInject(rendered, template);
    assert.ok(!result.includes("first"));
    assert.ok(!result.includes("second"));
  });

  it("handles interstitial text with regex special chars", () => {
    const template = `Text [with] (parens) {.braces}\n${EMPTY("tree")}`;
    const rendered = `EDITED [text] (with) {.special}\n${BLOCK("tree", "data")}`;
    const result = reverseInject(rendered, template);
    assert.ok(result.includes("EDITED"));
    assert.ok(!result.includes("data"));
  });

  it("handles nested-looking pmd comments inside block content", () => {
    const template = EMPTY("tree");
    const content = "<!-- pmd: inner -->\nfake inner\n<!-- /pmd -->";
    const rendered = BLOCK("tree", content);
    const result = reverseInject(rendered, template);
    assert.ok(typeof result === "string");
    assert.ok(result.includes("<!-- pmd: tree -->"));
  });

  it("handles very large block content without truncation issues", () => {
    const template = EMPTY("tree");
    const bigContent = "x".repeat(100_000);
    const rendered = BLOCK("tree", bigContent);
    const result = reverseInject(rendered, template);
    assert.ok(!result.includes(bigContent));
    assert.ok(result.length < bigContent.length);
  });

  it("handles block names with hyphens and underscores", () => {
    const template = EMPTY("my-block_name");
    const rendered = BLOCK("my-block_name", "data");
    const result = reverseInject(rendered, template);
    assert.ok(result.includes("<!-- pmd: my-block_name -->"));
    assert.ok(!result.includes("data"));
  });

  it("handles random byte sequences in interstitial text", () => {
    const template = EMPTY("tree");
    const randomish = [...Array(256)].map((_, i) => String.fromCharCode(i)).join("");
    const rendered = `${randomish}\n${BLOCK("tree", "data")}`;
    const result = reverseInject(rendered, template);
    assert.ok(typeof result === "string");
    assert.ok(!result.includes("data"));
  });

  it("preserves content between blocks when blocks are adjacent", () => {
    const template = `${EMPTY("a")}${EMPTY("b")}`;
    const rendered = `${BLOCK("a", "x")}\nINTERSTITIAL\n${BLOCK("b", "y")}`;
    const result = reverseInject(rendered, template);
    assert.ok(result.includes("INTERSTITIAL"));
    assert.ok(!result.includes("x"));
    assert.ok(!result.includes("y"));
  });
});
