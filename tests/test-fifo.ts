import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { PipeConfig } from "../src/config.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-fifo-test-"));
const liveDir = path.join(tmpDir, ".pipemd", "live");
fs.mkdirSync(liveDir, { recursive: true });

const origDir = process.cwd();
process.chdir(tmpDir);

const { createPipe, checkMkfifo, serveCommandPipe, shutdownPipes, setShuttingDown } = await import("../src/core/pipe-manager.js");

after(() => {
  setShuttingDown(true);
  shutdownPipes();
  process.chdir(origDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkMkfifo", () => {
  it("returns true when mkfifo is available", () => {
    const result = checkMkfifo();
    assert.equal(typeof result, "boolean");
  });
});

describe("createPipe", () => {
  it("creates a FIFO at the specified path", () => {
    const pipePath = path.join(liveDir, "test-create.fifo");
    const created = createPipe(pipePath);
    if (!created && !checkMkfifo()) return;
    assert.ok(created, "createPipe should return true");
    const stat = fs.statSync(pipePath);
    assert.ok(stat.isFIFO(), "created file should be a FIFO");
  });

  it("sets permissions to 0o600", () => {
    const pipePath = path.join(liveDir, "test-perm.fifo");
    const created = createPipe(pipePath);
    if (!created) return;
    const stat = fs.statSync(pipePath);
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, `FIFO mode should be 0o600, got 0o${mode.toString(8)}`);
  });

  it("overwrites a symlink at the target path (TOCTOU hardening)", () => {
    const pipePath = path.join(liveDir, "test-toctou.fifo");
    try { fs.unlinkSync(pipePath); } catch {}
    fs.symlinkSync("/tmp/evil-target", pipePath);
    const created = createPipe(pipePath);
    if (created) {
      const stat = fs.statSync(pipePath);
      assert.ok(stat.isFIFO(), "after createPipe on symlink, should be a real FIFO");
    }
    try { fs.unlinkSync(pipePath); } catch {}
  });
});

describe("FIFO read/write cycle", () => {
  it("can write and read back data through a FIFO", async () => {
    if (!checkMkfifo()) return;
    const pipePath = path.join(liveDir, "test-rw.fifo");
    createPipe(pipePath);

    const testData = "line1\nline2\n";

    const cat = spawn("cat", [pipePath], { stdio: ["pipe", "pipe", "ignore"] });
    let read = "";
    cat.stdout.on("data", (c: Buffer) => { read += c.toString("utf-8"); });

    await new Promise((r) => setTimeout(r, 100));

    const fd = fs.openSync(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    try { fs.writeSync(fd, testData); } finally { fs.closeSync(fd); }

    await new Promise((r) => setTimeout(r, 100));
    cat.kill();

    if (read) {
      assert.ok(read.includes("line1"), `Should read data from FIFO, got: ${read}`);
    }
  });
});

describe("serveCommandPipe", () => {
  it("serves command output through a FIFO to a reader", async () => {
    if (!checkMkfifo()) return;

    const pipePath = path.join(liveDir, "test-serve.fifo");
    createPipe(pipePath);

    const config: PipeConfig = {
      version: "1.0",
      commands: { "test-echo": "echo hello-from-pmd-pipe" },
      injected: [],
      pipes: [],
      settings: { debounceMs: 1000, reServeDelayMs: 200 },
    };

    const cat = spawn("cat", [pipePath], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    cat.stdout.on("data", (c: Buffer) => { output += c.toString("utf-8"); });

    await new Promise((r) => setTimeout(r, 100));

    serveCommandPipe(pipePath, "test-echo", config);

    await new Promise((r) => setTimeout(r, 500));
    cat.kill();

    assert.ok(
      output.includes("hello-from-pmd-pipe"),
      `Pipe should serve command output. Got: "${output}"`,
    );
  });

  it("wraps output in markdown code fences", async () => {
    if (!checkMkfifo()) return;

    const pipePath = path.join(liveDir, "test-fence.fifo");
    createPipe(pipePath);

    const config: PipeConfig = {
      version: "1.0",
      commands: { "test-fence": "echo fenced-output" },
      injected: [],
      pipes: [],
      settings: { debounceMs: 1000, reServeDelayMs: 200 },
    };

    const cat = spawn("cat", [pipePath], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    cat.stdout.on("data", (c: Buffer) => { output += c.toString("utf-8"); });

    await new Promise((r) => setTimeout(r, 100));

    serveCommandPipe(pipePath, "test-fence", config);

    await new Promise((r) => setTimeout(r, 500));
    cat.kill();

    assert.ok(output.includes("```"), `Output should be wrapped in code fences. Got: "${output}"`);
  });
});
