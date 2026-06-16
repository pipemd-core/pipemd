import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-concurrent-test-"));

fs.mkdirSync(path.join(tmpDir, ".pipemd", "crew"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "injected"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "sources"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "validation"), { recursive: true });

fs.writeFileSync(
  path.join(tmpDir, ".pipemd", "injection.yml"),
  `delivery: active
customCommandsAllowed: true
rules:
  on-start:
    - source: now
      scope: global
      interval-min: 1
    - source: custom
      scope: global
      command: "sleep 30"
`,
);

const origDir = process.cwd();
process.chdir(tmpDir);

const { resolveInjections } = await import("../src/core/injection-engine.js");
const { clearMemCache } = await import("../src/core/dedup.js");

after(() => {
  process.chdir(origDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("concurrent resolver execution", () => {
  it("does not stall when one resolver hangs — others complete within budget", async () => {
    clearMemCache();
    const start = Date.now();
    const payloads = await resolveInjections("on-start", undefined, "test-concurrent");
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 6000, `resolveInjections took ${elapsed}ms — should be under 6s (resolver budget + overhead)`);

    const nowPayload = payloads.find((p) => p.source === "now");
    assert.ok(nowPayload, "Should have a 'now' payload even though the custom resolver hangs");
    assert.ok(nowPayload.content.length > 0, "now payload should have content");

    const customPayload = payloads.find((p) => p.source === "custom");
    assert.equal(customPayload, undefined, "Hung custom resolver should NOT produce a payload (timed out)");
  });

  it("multiple fast resolvers all return results concurrently", async () => {
    clearMemCache();
    fs.writeFileSync(
      path.join(tmpDir, ".pipemd", "injection.yml"),
      `delivery: active
rules:
  on-start:
    - source: now
      scope: global
      interval-min: 1
`,
    );

    const start = Date.now();
    const payloads = await resolveInjections("on-start", undefined, "test-fast");
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `Fast resolvers should complete in <2s, took ${elapsed}ms`);
    assert.ok(payloads.length >= 1, "Should have at least the 'now' payload");
  });

  it("a resolver that throws is caught — others still complete", async () => {
    clearMemCache();
    fs.writeFileSync(
      path.join(tmpDir, ".pipemd", "injection.yml"),
      `delivery: active
customCommandsAllowed: true
rules:
  on-start:
    - source: now
      scope: global
      interval-min: 1
    - source: custom
      scope: global
      command: "exit 1"
`,
    );

    const payloads = await resolveInjections("on-start", undefined, "test-error");

    const nowPayload = payloads.find((p) => p.source === "now");
    assert.ok(nowPayload, "now resolver should still produce a payload when custom errors");
  });
});
