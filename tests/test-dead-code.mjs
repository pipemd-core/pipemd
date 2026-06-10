import { execFile, execFileSync } from "child_process";
import assert from "assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "Shared", "quality", "dead-code.sh");
const RUN_KNIP = path.join(ROOT, "scripts", "Shared", "quality", "run-knip.sh");
const FORMAT = path.join(ROOT, "scripts", "Shared", "quality", "format-knip.mjs");
const CACHE_DIR = path.join(ROOT, ".pipemd", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "dead-code.txt");
const PID_FILE = path.join(CACHE_DIR, "dead-code.pid");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function cleanup() {
  try { fs.rmSync(CACHE_FILE, { force: true }); } catch {}
  try { fs.rmSync(CACHE_FILE + ".tmp", { force: true }); } catch {}
  try { fs.rmSync(PID_FILE, { force: true }); } catch {}
}

function writeCache(content, ageSeconds = 0) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, content);
  if (ageSeconds > 0) {
    const mtime = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(CACHE_FILE, mtime, mtime);
  }
}

const KNIP_FIXTURE = JSON.stringify({
  issues: [
    {
      file: "src/foo.ts",
      exports: [{ name: "unusedFn", line: 10 }, { name: "deadHelper", line: 22 }],
      types: [{ name: "UnusedType", line: 5 }],
      dependencies: [{ name: "lodash" }],
    },
    {
      file: "src/bar.ts",
      files: [{ name: "src/dead.ts" }],
      devDependencies: [{ name: "moment" }],
    },
  ],
});

console.log("Dead-code block contract tests (plain node, execFile codepath)\n");

test("no cache — returns fast with pending message", async () => {
  cleanup();
  const start = Date.now();
  const { stdout } = await execFileAsync("bash", [SCRIPT], { cwd: ROOT });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `Took ${elapsed}ms — background may be blocking stdout`);
  assert.ok(stdout.includes("pending") || stdout.includes("running"), `Expected pending message, got: ${stdout.trim()}`);
  assert.ok(!stdout.includes("safe to delete"), `Output must not claim "safe to delete"`);
  cleanup();
});

test("fresh cache — returns cached content in < 100ms", async () => {
  cleanup();
  writeCache("Dead-code candidates (verify before deleting)\nUnused exports (3): foo, bar, baz");
  const start = Date.now();
  const { stdout } = await execFileAsync("bash", [SCRIPT], { cwd: ROOT });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `Took ${elapsed}ms — should be instant on fresh cache`);
  assert.ok(stdout.includes("Unused exports"), `Expected cached content, got: ${stdout.trim()}`);
  cleanup();
});

test("stale cache — returns stale content fast (background detached)", async () => {
  cleanup();
  writeCache("Dead-code candidates (verify before deleting)\nCached result", 1000);
  const start = Date.now();
  const { stdout } = await execFileAsync("bash", [SCRIPT], { cwd: ROOT });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `Took ${elapsed}ms — background process may be holding stdout pipe open`);
  assert.ok(stdout.includes("Cached result"), `Expected stale content, got: ${stdout.trim()}`);
  cleanup();
});

test("output is under MAX_DEADCODE lines", async () => {
  cleanup();
  const longContent = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join("\n");
  writeCache(longContent);
  const { stdout } = await execFileAsync("bash", [SCRIPT], { cwd: ROOT });
  const lineCount = stdout.trim().split("\n").length;
  assert.ok(lineCount <= 30, `Output has ${lineCount} lines, expected <= 30`);
  cleanup();
});

test("output frames as candidates, never 'safe to delete'", async () => {
  cleanup();
  writeCache("Dead-code candidates (verify before deleting — dynamic usage may be missed)\nUnused exports (1): foo");
  const { stdout } = await execFileAsync("bash", [SCRIPT], { cwd: ROOT });
  assert.ok(stdout.includes("candidates") || stdout.includes("pending"), `Expected candidates framing, got: ${stdout.trim()}`);
  assert.ok(!stdout.toLowerCase().includes("safe to delete"), `Must not say "safe to delete"`);
  cleanup();
});

test("run-knip.sh — no knip installed outputs install suggestion", () => {
  const result = execFileSync("bash", [RUN_KNIP], {
    encoding: "utf-8",
    timeout: 3000,
    cwd: ROOT,
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  assert.ok(result.includes("install knip") || result.includes("No dead-code scanner"), `Expected install suggestion, got: ${result.trim()}`);
});

test("run-knip.sh — exits 0 even when knip is missing", () => {
  try {
    execFileSync("bash", [RUN_KNIP], {
      encoding: "utf-8",
      timeout: 3000,
      cwd: ROOT,
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
  } catch (err) {
    assert.fail(`run-knip.sh should exit 0 when knip missing, but threw: ${err.message}`);
  }
});

test("format-knip.mjs — formats real knip JSON fixture", () => {
  const result = execFileSync("node", [FORMAT], {
    encoding: "utf-8",
    input: KNIP_FIXTURE,
    timeout: 3000,
    cwd: ROOT,
  });
  assert.ok(result.includes("Dead-code candidates"), `Expected candidates header, got: ${result.trim()}`);
  assert.ok(result.includes("Unused exports (2)"), `Expected exports count, got: ${result.trim()}`);
  assert.ok(result.includes("unusedFn"), `Expected export name, got: ${result.trim()}`);
  assert.ok(result.includes("Unused types (1)"), `Expected types count, got: ${result.trim()}`);
  assert.ok(result.includes("Unused files (1)"), `Expected files count, got: ${result.trim()}`);
  assert.ok(result.includes("Unused dependencies (1)"), `Expected deps count, got: ${result.trim()}`);
  assert.ok(result.includes("lodash"), `Expected dep name, got: ${result.trim()}`);
  assert.ok(result.includes("Unused devDependencies (1)"), `Expected devDeps count, got: ${result.trim()}`);
  assert.ok(result.includes("moment"), `Expected devDep name, got: ${result.trim()}`);
});

test("format-knip.mjs — empty issues outputs nothing found", () => {
  const result = execFileSync("node", [FORMAT], {
    encoding: "utf-8",
    input: JSON.stringify({ issues: [] }),
    timeout: 3000,
    cwd: ROOT,
  });
  assert.ok(result.includes("No unused"), `Expected nothing-found message, got: ${result.trim()}`);
});

test("format-knip.mjs — invalid JSON outputs error", () => {
  const result = execFileSync("node", [FORMAT], {
    encoding: "utf-8",
    input: "not json",
    timeout: 3000,
    cwd: ROOT,
  });
  assert.ok(result.includes("failed"), `Expected error message, got: ${result.trim()}`);
});

test("PID-liveness — stale PID file doesn't block new background job", async () => {
  cleanup();
  writeCache("Cached", 1000);
  fs.writeFileSync(PID_FILE, "999999");
  const start = Date.now();
  const { stdout } = await execFileAsync("bash", [SCRIPT], { cwd: ROOT });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `Took ${elapsed}ms — should return fast despite stale PID`);
  assert.ok(stdout.includes("Cached"), `Expected stale cache, got: ${stdout.trim()}`);
  cleanup();
});

console.log(`\n${passed} passed, ${failed} failed`);

cleanup();
process.exit(failed > 0 ? 1 : 0);
