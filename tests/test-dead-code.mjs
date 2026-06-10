import { execFile, execFileSync } from "child_process";
import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "Shared", "quality", "dead-code.sh");
const RUN_KNIP = path.join(ROOT, "scripts", "Shared", "quality", "run-knip.sh");
const FORMAT = path.join(ROOT, "scripts", "Shared", "quality", "format-knip.mjs");
const CACHE_DIR = path.join(ROOT, ".pipemd", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "dead-code.txt");
const PID_FILE = path.join(CACHE_DIR, "dead-code.pid");

let passed = 0;
let failed = 0;

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
      file: "package.json",
      dependencies: [
        { name: "@ast-grep/cli", line: 64, col: 6, pos: 2775 },
        { name: "zod", line: 70, col: 6, pos: 2931 },
      ],
    },
    {
      file: "src/core/pipe-manager.ts",
      exports: [
        { name: "ENXIO_MAX_RETRIES", line: 14, col: 14, pos: 588 },
        { name: "contextStreamEntries", line: 21, col: 14, pos: 800 },
      ],
    },
    {
      file: "src/core/crew.ts",
      types: [
        { name: "ProcInfo", line: 11, col: 15, pos: 514 },
        { name: "CrewStatusJson", line: 13, col: 15, pos: 654 },
      ],
    },
    {
      file: "scripts/Shared/quality/format-knip.mjs",
      files: [{ name: "scripts/Shared/quality/format-knip.mjs" }],
    },
    {
      file: "src/plugins/opencode-server.js",
      devDependencies: [{ name: "chalk", line: 5, col: 4, pos: 120 }],
    },
  ],
});

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log("Dead-code block contract tests (plain node, execFile codepath)\n");

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "knip-test-"));
  try {
    const result = execFileSync("bash", [RUN_KNIP], {
      encoding: "utf-8",
      timeout: 3000,
      cwd: tmpDir,
      env: { HOME: tmpDir, PATH: "/usr/bin:/bin", PMD_KNIP: "" },
    });
    assert.ok(result.includes("install knip") || result.includes("No dead-code scanner"), `Expected install suggestion, got: ${result.trim()}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("run-knip.sh — exits 0 even when knip is missing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "knip-test-"));
  try {
    execFileSync("bash", [RUN_KNIP], {
      encoding: "utf-8",
      timeout: 3000,
      cwd: tmpDir,
      env: { HOME: tmpDir, PATH: "/usr/bin:/bin", PMD_KNIP: "" },
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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
  assert.ok(result.includes("ENXIO_MAX_RETRIES"), `Expected export name, got: ${result.trim()}`);
  assert.ok(result.includes("Unused types (2)"), `Expected types count, got: ${result.trim()}`);
  assert.ok(result.includes("ProcInfo"), `Expected type name, got: ${result.trim()}`);
  assert.ok(result.includes("Unused files (1)"), `Expected files count, got: ${result.trim()}`);
  assert.ok(result.includes("Unused dependencies (2)"), `Expected deps count, got: ${result.trim()}`);
  assert.ok(result.includes("@ast-grep/cli"), `Expected dep name, got: ${result.trim()}`);
  assert.ok(result.includes("Unused devDependencies (1)"), `Expected devDeps count, got: ${result.trim()}`);
  assert.ok(result.includes("chalk"), `Expected devDep name, got: ${result.trim()}`);
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

test("format-knip.mjs — invalid JSON outputs parse error", () => {
  const result = execFileSync("node", [FORMAT], {
    encoding: "utf-8",
    input: "not json",
    timeout: 3000,
    cwd: ROOT,
  });
  assert.ok(result.includes("JSON parse error"), `Expected JSON parse error, got: ${result.trim()}`);
});

test("format-knip.mjs — runs against real knip output", () => {
  const knipBin = path.join(ROOT, "node_modules", ".bin", "knip");
  if (!fs.existsSync(knipBin)) return;
  let knipResult = "";
  try {
    knipResult = execFileSync(knipBin, ["--reporter", "json"], {
      encoding: "utf-8",
      timeout: 30000,
      cwd: ROOT,
    });
  } catch (err) {
    knipResult = err.stdout || "";
  }
  if (!knipResult) return;
  const realFormatted = execFileSync("node", [FORMAT], {
    encoding: "utf-8",
    input: knipResult,
    timeout: 3000,
    cwd: ROOT,
  });
  assert.ok(realFormatted.includes("Dead-code candidates"), `Expected header, got: ${realFormatted.trim()}`);
  assert.ok(!realFormatted.includes("failed"), `Formatter should not fail on real knip output: ${realFormatted.trim()}`);
});

test("format-knip.mjs — unexpected structure outputs structure error", () => {
  const result = execFileSync("node", [FORMAT], {
    encoding: "utf-8",
    input: JSON.stringify({ not_issues: [] }),
    timeout: 3000,
    cwd: ROOT,
  });
  assert.ok(result.includes("unexpected JSON structure"), `Expected structure error, got: ${result.trim()}`);
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

run();
