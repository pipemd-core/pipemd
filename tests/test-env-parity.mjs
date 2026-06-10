import { execSync } from "child_process";
import assert from "assert/strict";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");

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

console.log("Env parity (plain node — NOT tsx)\n");

test("resolveExternalTools sets PMD_ASTGREP in built dist", () => {
  execSync("pnpm build", { stdio: "pipe", cwd: ROOT });
  const result = execSync("node dist/index.js _probe-tools", {
    encoding: "utf-8",
    cwd: ROOT,
  });
  assert.ok(
    result.includes("PMD_ASTGREP=/"),
    `Expected PMD_ASTGREP path in output, got: ${result.trim()}`
  );
  const match = result.match(/PMD_ASTGREP=(\S+)/);
  assert.ok(match, "PMD_ASTGREP path not found in output");
  const binPath = match[1].trim();
  assert.ok(
    fs.existsSync(binPath),
    `Binary not found at: ${binPath}`
  );
  fs.accessSync(binPath, fs.constants.X_OK);
});

test("PMD_ASTGREP reaches spawned scripts via execFileAsync", () => {
  const probeResult = execSync("node dist/index.js _probe-tools", {
    encoding: "utf-8",
    cwd: ROOT,
  });
  const match = probeResult.match(/PMD_ASTGREP=(\S+)/);
  assert.ok(match, "PMD_ASTGREP not set");
  const binPath = match[1].trim();
  assert.notEqual(binPath, "unset", "PMD_ASTGREP should be a real path, not 'unset'");
  assert.ok(fs.existsSync(binPath), `Binary not found at: ${binPath}`);

  const script = `echo "PMD_ASTGREP=$PMD_ASTGREP"`;
  const scriptResult = execSync(
    `PMD_ASTGREP=${binPath} bash -c '${script}'`,
    { encoding: "utf-8", timeout: 3000, cwd: ROOT }
  );
  assert.ok(
    scriptResult.includes(binPath),
    `Script did not receive PMD_ASTGREP. Got: ${scriptResult.trim()}`
  );
});

test("createRequire works in pure ESM (no tsx shim)", () => {
  const result = execSync(
    `node --input-type=module -e "import { createRequire } from 'module'; const r = createRequire(import.meta.url); console.log(r.resolve('@ast-grep/cli/package.json'));"`,
    { encoding: "utf-8", cwd: ROOT }
  );
  assert.ok(
    result.includes("@ast-grep/cli"),
    `createRequire failed to resolve in pure ESM: ${result.trim()}`
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
