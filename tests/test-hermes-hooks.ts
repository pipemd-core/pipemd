import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { hermesAdapter } from "../src/core/hermes-hooks.js";
import type { HookInstallResult } from "../src/core/hooks.js";

const TARGET_FILE = "WORKSPACE_CONTEXT.md";
const MARKER_FILE = path.join(".hermes", "pipemd-context.json");

function freshDir(prefix = "pmd-hermes-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function isFifo(p: string): boolean {
  try {
    return fs.statSync(p).isFIFO();
  } catch {
    return false;
  }
}

describe("Hermes adapter — installHooks", () => {
  it("creates WORKSPACE_CONTEXT.md as a named pipe (FIFO)", () => {
    const dir = freshDir();
    try {
      const result = hermesAdapter.installHooks(dir, "passive", false, false);
      const pipePath = path.join(dir, TARGET_FILE);
      assert.ok(fs.existsSync(pipePath), "WORKSPACE_CONTEXT.md should exist");
      assert.ok(isFifo(pipePath), "WORKSPACE_CONTEXT.md should be a named pipe");
      assert.equal(result.harness, "Hermes");
      assert.equal(result.mechanism, "pipe");
      assert.equal(result.installed, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a pipemd-context.json marker under .hermes/", () => {
    const dir = freshDir();
    try {
      hermesAdapter.installHooks(dir, "passive", false, false);
      const markerPath = path.join(dir, MARKER_FILE);
      assert.ok(fs.existsSync(markerPath), "marker file should exist");
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
      assert.equal(marker.target, TARGET_FILE);
      assert.equal(marker.mechanism, "pipe");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — re-installing when the pipe already exists does not recreate it", () => {
    const dir = freshDir();
    try {
      hermesAdapter.installHooks(dir, "passive", false, false);
      const pipePath = path.join(dir, TARGET_FILE);
      const before = fs.statSync(pipePath);
      const result = hermesAdapter.installHooks(dir, "passive", false, false);
      assert.equal(isFifo(pipePath), true);
      assert.equal(result.harness, "Hermes");
      assert.equal(result.mechanism, "pipe");
      // inode stable (fifo not recreated)
      const after = fs.statSync(pipePath);
      assert.equal(before.ino, after.ino);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backs up an existing regular WORKSPACE_CONTEXT.md before creating the pipe", () => {
    const dir = freshDir("pmd-hermes-bak-");
    try {
      const target = path.join(dir, TARGET_FILE);
      fs.writeFileSync(target, "# my hermes notes\n", "utf-8");
      const result = hermesAdapter.installHooks(dir, "passive", false, false);
      assert.ok(isFifo(target), "should be a pipe after install");
      assert.equal(result.installed, true);
      const bak = target + ".pipemd.bak";
      assert.ok(fs.existsSync(bak), "backup should exist");
      assert.equal(fs.readFileSync(bak, "utf-8"), "# my hermes notes\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Hermes adapter — removeHooks", () => {
  it("removes the WORKSPACE_CONTEXT.md named pipe", () => {
    const dir = freshDir("pmd-hermes-rm-");
    try {
      hermesAdapter.installHooks(dir, "passive", false, false);
      const pipePath = path.join(dir, TARGET_FILE);
      assert.ok(isFifo(pipePath));
      const result = hermesAdapter.removeHooks(dir);
      assert.equal(result.harness, "Hermes");
      assert.ok(result.installed, "should report something removed");
      assert.ok(!fs.existsSync(pipePath), "pipe should be gone after remove");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the pipemd-context.json marker", () => {
    const dir = freshDir("pmd-hermes-mark-");
    try {
      hermesAdapter.installHooks(dir, "passive", false, false);
      const markerPath = path.join(dir, MARKER_FILE);
      assert.ok(fs.existsSync(markerPath));
      hermesAdapter.removeHooks(dir);
      assert.ok(!fs.existsSync(markerPath), "marker should be gone");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores a backed-up WORKSPACE_CONTEXT.md on uninstall", () => {
    const dir = freshDir("pmd-hermes-restore-");
    try {
      const target = path.join(dir, TARGET_FILE);
      fs.writeFileSync(target, "# original notes\n", "utf-8");
      hermesAdapter.installHooks(dir, "passive", false, false);
      assert.ok(isFifo(target));
      hermesAdapter.removeHooks(dir);
      assert.ok(fs.existsSync(target), "file restored after uninstall");
      assert.equal(isFifo(target), false, "restored file is a regular file, not a pipe");
      assert.equal(fs.readFileSync(target, "utf-8"), "# original notes\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not delete a regular (non-pipe) WORKSPACE_CONTEXT.md", () => {
    const dir = freshDir("pmd-hermes-keep-");
    try {
      const target = path.join(dir, TARGET_FILE);
      fs.writeFileSync(target, "# hand-written\n", "utf-8");
      const result: HookInstallResult = hermesAdapter.removeHooks(dir);
      assert.ok(fs.existsSync(target), "regular file must not be touched by remove");
      assert.equal(fs.readFileSync(target, "utf-8"), "# hand-written\n");
      assert.equal(result.installed, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports nothing to remove on a clean directory", () => {
    const dir = freshDir("pmd-hermes-clean-");
    try {
      const result = hermesAdapter.removeHooks(dir);
      assert.equal(result.installed, false);
      assert.match(result.detail, /nothing to remove/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
