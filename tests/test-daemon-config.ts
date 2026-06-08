import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-daemon-config-"));
const pipemdDir = path.join(tmpDir, ".pipemd");
fs.mkdirSync(pipemdDir, { recursive: true });

const origDir = process.cwd();
process.chdir(tmpDir);

const { validateConfig, ConfigError, loadConfig } = await import("../src/core/daemon-config.js");

describe("validateConfig", () => {
  it("accepts a valid minimal config", () => {
    const cfg = validateConfig({
      version: "1.0",
      commands: { tree: "echo tree" },
    });
    assert.equal(cfg.version, "1.0");
    assert.ok(cfg.commands);
    assert.deepEqual(cfg.pipes, []);
    assert.deepEqual(cfg.injected, []);
  });

  it("accepts a fully populated config", () => {
    const cfg = validateConfig({
      version: "1.0",
      commands: { tree: "echo tree" },
      pipes: [{ file: "AGENTS.md", render: ".pipemd/template.md" }],
      injected: [{ file: ".pipemd/template.md", watch: true }],
      settings: {
        debounceMs: 5000,
        reServeDelayMs: 2000,
        tokenProfile: "high",
      },
    });
    assert.equal(cfg.settings.debounceMs, 5000);
    assert.equal(cfg.settings.reServeDelayMs, 2000);
    assert.equal(cfg.settings.tokenProfile, "high");
    assert.equal(cfg.pipes.length, 1);
    assert.equal(cfg.injected.length, 1);
  });

  it("rejects null input", () => {
    assert.throws(() => validateConfig(null), (err: unknown) => err instanceof ConfigError);
  });

  it("rejects array input", () => {
    assert.throws(() => validateConfig([]), (err: unknown) => err instanceof ConfigError);
  });

  it("rejects string input", () => {
    assert.throws(() => validateConfig("not an object"), (err: unknown) => err instanceof ConfigError);
  });

  it("rejects missing commands", () => {
    assert.throws(
      () => validateConfig({ version: "1.0" }),
      (err: unknown) => err instanceof ConfigError && (err as ConfigError).message.includes("missing 'commands'"),
    );
  });

  it("rejects null commands", () => {
    assert.throws(
      () => validateConfig({ version: "1.0", commands: null }),
      (err: unknown) => err instanceof ConfigError && (err as ConfigError).message.includes("missing 'commands'"),
    );
  });

  it("rejects array commands", () => {
    assert.throws(
      () => validateConfig({ version: "1.0", commands: ["echo"] }),
      (err: unknown) => err instanceof ConfigError && (err as ConfigError).message.includes("'commands' must be a mapping"),
    );
  });

  it("rejects non-array pipes", () => {
    assert.throws(
      () => validateConfig({ version: "1.0", commands: { a: "echo" }, pipes: "not-array" }),
      (err: unknown) => err instanceof ConfigError && (err as ConfigError).message.includes("'pipes' must be an array"),
    );
  });

  it("rejects non-array injected", () => {
    assert.throws(
      () => validateConfig({ version: "1.0", commands: { a: "echo" }, injected: "not-array" }),
      (err: unknown) => err instanceof ConfigError && (err as ConfigError).message.includes("'injected' must be an array"),
    );
  });

  it("fills default settings when missing", () => {
    const cfg = validateConfig({ version: "1.0", commands: { a: "echo" } });
    assert.equal(cfg.settings.debounceMs, 3000);
    assert.ok(cfg.settings.reServeDelayMs);
    assert.equal(cfg.settings.tokenProfile, "medium");
  });

  it("fills default debounceMs when not a number", () => {
    const cfg = validateConfig({
      version: "1.0",
      commands: { a: "echo" },
      settings: { debounceMs: "not-a-number" },
    });
    assert.equal(cfg.settings.debounceMs, 3000);
  });

  it("fills default reServeDelayMs when not a number", () => {
    const cfg = validateConfig({
      version: "1.0",
      commands: { a: "echo" },
      settings: { reServeDelayMs: "bad" },
    });
    assert.equal(typeof cfg.settings.reServeDelayMs, "number");
  });

  it("fills default tokenProfile when not a string", () => {
    const cfg = validateConfig({
      version: "1.0",
      commands: { a: "echo" },
      settings: { tokenProfile: 42 },
    });
    assert.equal(cfg.settings.tokenProfile, "medium");
  });

  it("preserves valid numeric settings", () => {
    const cfg = validateConfig({
      version: "1.0",
      commands: { a: "echo" },
      settings: { debounceMs: 1000, reServeDelayMs: 500 },
    });
    assert.equal(cfg.settings.debounceMs, 1000);
    assert.equal(cfg.settings.reServeDelayMs, 500);
  });

  it("defaults null pipes to empty array", () => {
    const cfg = validateConfig({ version: "1.0", commands: { a: "echo" }, pipes: null });
    assert.deepEqual(cfg.pipes, []);
  });

  it("defaults null injected to empty array", () => {
    const cfg = validateConfig({ version: "1.0", commands: { a: "echo" }, injected: null });
    assert.deepEqual(cfg.injected, []);
  });
});

describe("loadConfig", () => {
  it("throws ConfigError when config file is missing", () => {
    try { fs.unlinkSync(path.join(pipemdDir, "config.yml")); } catch {}
    assert.throws(() => loadConfig(), (err: unknown) => err instanceof ConfigError);
  });

  it("throws ConfigError for invalid YAML syntax", () => {
    fs.writeFileSync(path.join(pipemdDir, "config.yml"), "{{invalid yaml", "utf-8");
    assert.throws(() => loadConfig(), (err: unknown) => err instanceof ConfigError);
  });

  it("loads and validates a valid config file", () => {
    fs.writeFileSync(
      path.join(pipemdDir, "config.yml"),
      `version: "1.0"
commands:
  tree: "echo tree"
  deps: "echo deps"
settings:
  debounceMs: 2000
`,
      "utf-8",
    );
    const cfg = loadConfig();
    assert.equal(cfg.version, "1.0");
    assert.equal(cfg.commands["tree"], "echo tree");
    assert.equal(cfg.commands["deps"], "echo deps");
    assert.equal(cfg.settings.debounceMs, 2000);
  });

  it("throws ConfigError for valid YAML but invalid config structure", () => {
    fs.writeFileSync(path.join(pipemdDir, "config.yml"), "just-a-string", "utf-8");
    assert.throws(() => loadConfig(), (err: unknown) => err instanceof ConfigError);
  });
});

after(() => {
  process.chdir(origDir);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
