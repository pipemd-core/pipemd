import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-new-resolvers-test-"));
fs.mkdirSync(path.join(tmpDir, ".pipemd"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".pipemd", "crew"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "sources"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });

fs.writeFileSync(
  path.join(tmpDir, ".pipemd", "injection.yml"),
  `delivery: active\nrules: {}\n`,
);

const origDir = process.cwd();

before(() => {
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(origDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const { RESOLVERS } = await import("../src/core/injection-engine.js");
const { writeSessionAtomic, resolveActiveSession, invalidateSessionListCache } = await import("../src/core/crew.js");
import type { InjectionConfig } from "../src/core/injection-types.js";
const { loadInjectionConfig } = await import("../src/core/injection-types.js");

const config: InjectionConfig = loadInjectionConfig();

describe("resolveImportGraph", () => {
  it("returns empty string when no targetFile", async () => {
    const result = await RESOLVERS["import-graph"]({
      trigger: "before-edit",
      targetFile: undefined,
      config,
    });
    assert.equal(result, "");
  });

  it("returns empty string for unsupported extension", async () => {
    const result = await RESOLVERS["import-graph"]({
      trigger: "before-edit",
      targetFile: "README.md",
      config,
    });
    assert.equal(result, "");
  });

  it("returns empty string for file with no imports", async () => {
    fs.writeFileSync(path.join(tmpDir, "src", "orphan.ts"), "export const x = 1;\n");
    const result = await RESOLVERS["import-graph"]({
      trigger: "before-edit",
      targetFile: "src/orphan.ts",
      config,
    });
    assert.equal(result, "");
  });

  it("detects imports in a .ts file", async () => {
    fs.writeFileSync(path.join(tmpDir, "src", "dep.ts"), "export const dep = 42;\n");
    fs.writeFileSync(
      path.join(tmpDir, "src", "consumer.ts"),
      `import { dep } from './dep.js';\nexport const y = dep + 1;\n`,
    );
    const result = await RESOLVERS["import-graph"]({
      trigger: "before-edit",
      targetFile: "src/consumer.ts",
      config,
    });
    assert.ok(result.includes("Imports:"), `Expected "Imports:" in result, got: ${result}`);
    assert.ok(result.includes("dep"), `Expected import specifier "dep" in result, got: ${result}`);
  });

  it("detects imported-by relationships", async () => {
    fs.writeFileSync(path.join(tmpDir, "src", "base.ts"), "export const base = true;\n");
    fs.writeFileSync(
      path.join(tmpDir, "src", "uses-base.ts"),
      `import { base } from './base.js';\n`,
    );
    const result = await RESOLVERS["import-graph"]({
      trigger: "before-edit",
      targetFile: "src/base.ts",
      config,
    });
    assert.ok(result.includes("Imported by:"), `Expected "Imported by:" in result, got: ${result}`);
    assert.ok(result.includes("base"), `Expected imported symbol "base" in result, got: ${result}`);
  });

  it("does not false-match files with similar basename", async () => {
    fs.writeFileSync(path.join(tmpDir, "src", "cache.ts"), "export const cache = 1;\n");
    fs.writeFileSync(path.join(tmpDir, "src", "some-cache.ts"), "export const sc = 2;\n");
    fs.writeFileSync(
      path.join(tmpDir, "src", "consumer-a.ts"),
      `import { cache } from './cache.js';\n`,
    );
    const result = await RESOLVERS["import-graph"]({
      trigger: "before-edit",
      targetFile: "src/cache.ts",
      config,
    });
    assert.ok(result.includes("Imported by:"), `Expected "Imported by:" in result, got: ${result}`);
    assert.ok(!result.includes("some-cache"), `Should not match some-cache, got: ${result}`);
  });

  it("detects imports from subdirectory", async () => {
    fs.mkdirSync(path.join(tmpDir, "src", "sub"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "sub", "mod.ts"), "export const mod = 1;\n");
    fs.writeFileSync(
      path.join(tmpDir, "src", "sub", "index.ts"),
      `export { mod } from './mod.js';\n`,
    );
    const result = await RESOLVERS["import-graph"]({
      trigger: "before-edit",
      targetFile: "src/sub/mod.ts",
      config,
    });
    assert.ok(result.includes("Imported by:"), `Expected "Imported by:" in result, got: ${result}`);
    assert.ok(result.includes("index.ts"), `Expected "index.ts" in result, got: ${result}`);
  });

  it("detects double-quote imports", async () => {
    fs.writeFileSync(path.join(tmpDir, "src", "dq-target.ts"), "export const dq = 1;\n");
    fs.writeFileSync(
      path.join(tmpDir, "src", "dq-consumer.ts"),
      `import { dq } from "./dq-target.js";\n`,
    );
    const result = await RESOLVERS["import-graph"]({
      trigger: "before-edit",
      targetFile: "src/dq-target.ts",
      config,
    });
    assert.ok(result.includes("Imported by:"), `Expected "Imported by:" in result, got: ${result}`);
  });

  it("shows multiple import specifiers with arrow notation", async () => {
    fs.writeFileSync(path.join(tmpDir, "src", "multi.ts"), "export const a = 1; export const b = 2;\n");
    fs.writeFileSync(
      path.join(tmpDir, "src", "multi-consumer.ts"),
      `import { a, b } from './multi.js';\n`,
    );
    const result = await RESOLVERS["import-graph"]({
      trigger: "before-edit",
      targetFile: "src/multi.ts",
      config,
    });
    assert.ok(result.includes("Imported by:"), `Expected "Imported by:" in result, got: ${result}`);
    assert.ok(result.includes("a, b") || (result.includes("a") && result.includes("b")), `Expected both specifiers in result, got: ${result}`);
  });

  it("shows import specifiers in Imports section", async () => {
    fs.writeFileSync(path.join(tmpDir, "src", "lib-a.ts"), "export const la = 1;\n");
    fs.writeFileSync(path.join(tmpDir, "src", "lib-b.ts"), "export const lb = 2;\n");
    fs.writeFileSync(
      path.join(tmpDir, "src", "multi-importer.ts"),
      `import { la } from './lib-a.js';\nimport { lb } from './lib-b.js';\n`,
    );
    const result = await RESOLVERS["import-graph"]({
      trigger: "before-edit",
      targetFile: "src/multi-importer.ts",
      config,
    });
    assert.ok(result.includes("Imports:"), `Expected "Imports:" in result, got: ${result}`);
    assert.ok(result.includes("la"), `Expected specifier "la" in result, got: ${result}`);
    assert.ok(result.includes("lb"), `Expected specifier "lb" in result, got: ${result}`);
  });
});

describe("resolveExports", () => {
  it("returns empty string when no targetFile", async () => {
    const result = await RESOLVERS["exports"]({
      trigger: "before-edit",
      targetFile: undefined,
      config,
    });
    assert.equal(result, "");
  });

  it("returns empty string for unsupported extension", async () => {
    const result = await RESOLVERS["exports"]({
      trigger: "before-edit",
      targetFile: "style.css",
      config,
    });
    assert.equal(result, "");
  });

  it("returns empty string for file with no exports", async () => {
    fs.writeFileSync(path.join(tmpDir, "src", "no-export.ts"), "const x = 1;\n");
    const result = await RESOLVERS["exports"]({
      trigger: "before-edit",
      targetFile: "src/no-export.ts",
      config,
    });
    assert.equal(result, "");
  });

  it("detects exported functions and constants", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "has-exports.ts"),
      `export function foo() {}\nexport const bar = 1;\nexport type Baz = string;\n`,
    );
    const result = await RESOLVERS["exports"]({
      trigger: "before-edit",
      targetFile: "src/has-exports.ts",
      config,
    });
    assert.ok(result.includes("Exports:"), `Expected "Exports:" in result, got: ${result}`);
    assert.ok(result.includes("function foo()"), `Expected "function foo()" in result, got: ${result}`);
    assert.ok(result.includes("const bar = 1"), `Expected "const bar = 1" in result, got: ${result}`);
    assert.ok(result.includes("type Baz = string"), `Expected "type Baz = string" in result, got: ${result}`);
  });

  it("detects env var references", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "env-file.ts"),
      `export const port = process.env.PORT || 3000;\nexport const debug = process.env.DEBUG;\n`,
    );
    const result = await RESOLVERS["exports"]({
      trigger: "before-edit",
      targetFile: "src/env-file.ts",
      config,
    });
    assert.ok(result.includes("env refs:"), `Expected "env refs:" in result, got: ${result}`);
    assert.ok(result.includes("PORT"), `Expected "PORT" in result, got: ${result}`);
    assert.ok(result.includes("DEBUG"), `Expected "DEBUG" in result, got: ${result}`);
  });

  it("deduplicates env vars", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "dup-env.ts"),
      `const a = process.env.API_KEY;\nconst b = process.env.API_KEY;\nexport const c = a + b;\n`,
    );
    const result = await RESOLVERS["exports"]({
      trigger: "before-edit",
      targetFile: "src/dup-env.ts",
      config,
    });
    const matches = result.match(/API_KEY/g);
    assert.ok(matches && matches.length === 1, `Expected exactly 1 occurrence of API_KEY, got ${matches?.length}: ${result}`);
  });

  it("shows full function signatures with parameters", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "sig-file.ts"),
      `export function greet(name: string, age: number): string { return name; }\nexport const add = (a: number, b: number): number => a + b;\n`,
    );
    const result = await RESOLVERS["exports"]({
      trigger: "before-edit",
      targetFile: "src/sig-file.ts",
      config,
    });
    assert.ok(result.includes("function greet(name: string, age: number): string"), `Expected full signature in result, got: ${result}`);
  });

  it("marks default exports", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "src", "default-export.ts"),
      `export default function main() {}\n`,
    );
    const result = await RESOLVERS["exports"]({
      trigger: "before-edit",
      targetFile: "src/default-export.ts",
      config,
    });
    assert.ok(result.includes("default function main"), `Expected "default" marker in result, got: ${result}`);
  });
});

describe("resolveSessionDiff", () => {
  it("returns empty string when no active session", async () => {
    invalidateSessionListCache();
    const orig = process.env.PMD_SESSION;
    delete process.env.PMD_SESSION;
    const result = await RESOLVERS["session-diff"]({
      trigger: "on-idle",
      config,
    });
    process.env.PMD_SESSION = orig;
    assert.equal(result, "");
  });

  it("returns empty string when session has no claimed files", async () => {
    const session = {
      schema: 1,
      id: "cr_sdiff_empty",
      role: "coordinator",
      harness: "Test",
      pid: 99998,
      ppid: 1,
      coordinatorId: null,
      claimedFiles: [],
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      cwd: tmpDir,
    };
    writeSessionAtomic(session);
    const orig = process.env.PMD_SESSION;
    process.env.PMD_SESSION = session.id;
    try {
      const result = await RESOLVERS["session-diff"]({
        trigger: "on-idle",
        config,
      });
      assert.equal(result, "");
    } finally {
      process.env.PMD_SESSION = orig;
    }
  });

  it("returns diff stat for claimed files", async () => {
    fs.writeFileSync(path.join(tmpDir, "src", "changed.ts"), "export const changed = true;\n");
    try {
      await execFileAsync("git", ["init"], { cwd: tmpDir, timeout: 5000 });
      await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, timeout: 5000 });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: tmpDir, timeout: 5000 });
      await execFileAsync("git", ["add", "."], { cwd: tmpDir, timeout: 5000 });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: tmpDir, timeout: 5000 });
    } catch {
      // git may already be initialized
    }
    fs.writeFileSync(path.join(tmpDir, "src", "changed.ts"), "export const changed = false;\n");

    const session = {
      schema: 1,
      id: "cr_sdiff_claim",
      role: "coordinator",
      harness: "Test",
      pid: 99997,
      ppid: 1,
      coordinatorId: null,
      claimedFiles: [{ path: "src/changed.ts", claimedAt: new Date().toISOString() }],
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      cwd: tmpDir,
    };
    writeSessionAtomic(session);
    const orig = process.env.PMD_SESSION;
    process.env.PMD_SESSION = session.id;
    try {
      const result = await RESOLVERS["session-diff"]({
        trigger: "on-idle",
        config,
      });
      assert.ok(result.includes("src/changed.ts"), `Expected "src/changed.ts" in result, got: ${result}`);
    } finally {
      process.env.PMD_SESSION = orig;
    }
  });
});
