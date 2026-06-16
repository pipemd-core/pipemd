import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { hermesAdapter } from "../src/core/hermes-hooks.js";
import { installHooks, removeHooks } from "../src/core/hooks.js";
import type { HookInstallResult } from "../src/core/hooks.js";

const SKILL_DIR_REL = path.join(".hermes", "skills", "devops", "pipemd-context");
const SKILL_REL = path.join(SKILL_DIR_REL, "SKILL.md");
const PMD_MARKER = "<!-- pipemd-managed-skill -->";

let tmpDir: string;
let fakeHome: string;
let origCwd: string;
let origHome: string;

beforeEach(() => {
  origCwd = process.cwd();
  origHome = process.env.HOME!;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-hermes-test-"));
  fs.mkdirSync(path.join(tmpDir, ".pipemd"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, ".pipemd", "config.yml"), 'version: "1.0"\n');
  fakeHome = path.join(tmpDir, "fake-home");
  fs.mkdirSync(fakeHome, { recursive: true });
  process.chdir(tmpDir);
  process.env.HOME = fakeHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function skillFile(): string {
  return path.join(fakeHome, SKILL_REL);
}

// ─── Phase 1 (regression — must stay green) ─────────────────────────────

describe("hermesAdapter \u2014 installHooks", () => {
  it("writes the pipemd-context skill under HOME/.hermes/skills with the managed marker", () => {
    const r = hermesAdapter.installHooks(tmpDir, "passive", false, true);
    assert.equal(r.harness, "Hermes");
    assert.equal(r.mechanism, "skill+pipe");
    assert.equal(r.installed, true);
    const skill = skillFile();
    assert.ok(fs.existsSync(skill), "skill file should exist");
    assert.ok(fs.readFileSync(skill, "utf-8").includes(PMD_MARKER), "skill must carry the managed marker");
  });

  it("is idempotent \u2014 re-install (force=false) reports installed=false and 'already installed'", () => {
    hermesAdapter.installHooks(tmpDir, "passive", false, true);
    const r = hermesAdapter.installHooks(tmpDir, "passive", false, false);
    assert.equal(r.installed, false);
    assert.match(r.detail, /already installed/);
  });

  it("dryRun does not write files but reports 'needs update'", () => {
    const r = hermesAdapter.installHooks(tmpDir, "passive", true, true);
    assert.equal(r.installed, false);
    assert.match(r.detail, /needs update/);
    assert.ok(!fs.existsSync(skillFile()), "dryRun must not write the skill");
  });

  it("ensures WORKSPACE_CONTEXT.md pipe entry in config.yml with mode: pipe", () => {
    hermesAdapter.installHooks(tmpDir, "passive", false, true);
    const cfg = fs.readFileSync(path.join(tmpDir, ".pipemd", "config.yml"), "utf-8");
    assert.match(cfg, /WORKSPACE_CONTEXT\.md/);
    assert.match(cfg, /pipe/);
  });

  it("does not advertise an injectionMode (Hermes has no active injection)", () => {
    const r = hermesAdapter.installHooks(tmpDir, "active", false, true);
    assert.equal(r.injectionMode, undefined);
  });

  it("force rewrites the skill even when content is identical", () => {
    hermesAdapter.installHooks(tmpDir, "passive", false, false);
    const r = hermesAdapter.installHooks(tmpDir, "passive", false, true);
    assert.equal(r.installed, true);
  });
});

describe("hermesAdapter \u2014 removeHooks", () => {
  it("deletes only pipemd-managed skills", () => {
    hermesAdapter.installHooks(tmpDir, "passive", false, true);
    const r = hermesAdapter.removeHooks(tmpDir);
    assert.equal(r.harness, "Hermes");
    assert.equal(r.installed, true);
    assert.ok(!fs.existsSync(skillFile()), "managed skill should be gone");
  });

  it("is a no-op when no managed skill is present", () => {
    const r = hermesAdapter.removeHooks(tmpDir);
    assert.equal(r.installed, false);
    assert.match(r.detail, /nothing to remove/);
  });

  it("leaves a user-authored skill of the same name untouched", () => {
    const skillDir = path.dirname(skillFile());
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      skillFile(),
      "---\nname: pipemd-context\n---\nuser content, no marker\n",
    );
    const r = hermesAdapter.removeHooks(tmpDir);
    assert.equal(r.installed, false);
    assert.ok(fs.existsSync(skillFile()), "user skill must survive");
  });
});

describe("hooks.ts dispatch for Hermes", () => {
  it("installHooks('Hermes') dispatches to the adapter (skill+pipe), not instruction-only", () => {
    const r = installHooks("Hermes", tmpDir, "passive", false, true) as HookInstallResult;
    assert.equal(r.harness, "Hermes");
    assert.notEqual(r.mechanism, "instruction");
    assert.equal(r.mechanism, "skill+pipe");
    assert.ok(fs.existsSync(skillFile()), "skill should be deployed via the router");
  });

  it("removeHooks('Hermes') dispatches to the adapter", () => {
    installHooks("Hermes", tmpDir, "passive", false, true);
    assert.ok(fs.existsSync(skillFile()));
    const r = removeHooks("Hermes", tmpDir) as HookInstallResult;
    assert.equal(r.harness, "Hermes");
    assert.ok(!fs.existsSync(skillFile()), "skill gone after routed remove");
  });
});
