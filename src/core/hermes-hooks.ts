import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { DeliveryMode } from "./injection-types.js";
import type { HookInstallResult, HarnessAdapter } from "./hooks.js";
import type { PipeConfig } from "../config.js";
import { log, errMsg } from "./logger.js";

const SKILL_NAME = "pipemd-context";
const SKILL_CATEGORY = "devops";
const TARGET_FILE = "WORKSPACE_CONTEXT.md";
const TEMPLATE_RENDER = ".pipemd/template.md";
const CONFIG_REL = path.join(".pipemd", "config.yml");

/** Marker written into the skill body so removeHooks can detect our install. */
const PMD_MARKER = "<!-- pipemd-managed-skill -->";

function hermesSkillsDir(): string {
  return path.join(os.homedir(), ".hermes", "skills", SKILL_CATEGORY);
}

function skillPath(): string {
  return path.join(hermesSkillsDir(), SKILL_NAME, "SKILL.md");
}

function safeRead(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch (err: unknown) {
    log.debug(`safeRead ${p}: ${errMsg(err)}`);
    return "";
  }
}

/**
 * Hermes skill body. Kept inline (not a separate template file) because it is
 * the only Hermes-specific artifact. Phase 1 covers two concerns:
 *   1. Reading context (WORKSPACE_CONTEXT.md FIFO via cat + pmd run fallback).
 *   2. Crew coordination (register, claim, heartbeat, leave).
 */
function skillBody(): string {
  return [
    "---",
    "name: pipemd-context",
    "description: PipeMD context for Hermes. Read WORKSPACE_CONTEXT.md for live project",
    "  context, register as a crew coordinator, and claim files you are managing so",
    "  coding agents (OpenCode/Claude) avoid edit conflicts.",
    "version: 1.0.0",
    "metadata:",
    "  pipemd-managed: true",
    "---",
    "",
    "# PipeMD Context (Hermes)",
    "",
    "This project is PipeMD-enabled. PipeMD renders live project context (git state,",
    "architecture map, crew status, file errors) into `WORKSPACE_CONTEXT.md`, kept",
    "fresh by the PipeMD daemon via a named pipe (mkfifo).",
    "",
    "## Reading the context",
    "",
    "Prefer `pmd run` for a guaranteed-fresh render streamed to stdout:",
    "  pmd run",
    "",
    "For the live pipe read, use `cat` (the FIFO is safe with cat):",
    "  cat WORKSPACE_CONTEXT.md",
    "",
    "Do NOT use read_file on WORKSPACE_CONTEXT.md directly \u2014 it is a named pipe",
    "(FIFO) and a synchronous read may block until the daemon opens the write end.",
    "If a cat read looks stale or empty, the daemon may not be running: start it with",
    "`pmd start`, or fall back to `pmd run` for a one-shot render.",
    "",
    "It contains `<!-- pmd: <id> --> ... <!-- /pmd -->` blocks populated by the",
    "daemon. Treat their contents as read-only ground truth.",
    "",
    "## Crew coordination",
    "",
    "Register as a coordinator so coding agents see you and respect your file claims:",
    "  pmd crew join --role coordinator --label \"Hermes-Orchestrator\" --harness Hermes",
    "Export the returned session id for stable identity across calls:",
    "  export PMD_SESSION=cr_<id>",
    "Claim files you are managing:",
    "  pmd crew claim path/to/file --note \"refactoring auth\"",
    "See everyone:",
    "  pmd crew render",
    "Refresh liveness at least every 60s during long work:",
    "  pmd crew heartbeat",
    "Leave when done:",
    "  pmd crew leave",
    "",
    PMD_MARKER,
    "",
  ].join("\n");
}

/**
 * Idempotently ensure `.pipemd/config.yml` has a WORKSPACE_CONTEXT.md pipe entry
 * (render: .pipemd/template.md, mode: pipe). The scaffold adds the pipe on
 * `pmd init`; this is insurance for projects that ran init before the adapter
 * existed. Mirrors scaffold.ts updateConfigInjected.
 */
function reconcileConfig(cwd: string, dryRun: boolean): boolean {
  const cfgPath = path.join(cwd, CONFIG_REL);
  let raw: string;
  try {
    raw = fs.readFileSync(cfgPath, "utf-8");
  } catch (err: unknown) {
    log.debug(`reconcileConfig read: ${errMsg(err)}`);
    return false;
  }

  let config: PipeConfig;
  try {
    config = parseYaml(raw) as PipeConfig;
  } catch (err: unknown) {
    log.debug(`reconcileConfig parse: ${errMsg(err)}`);
    return false;
  }
  if (!config || typeof config !== "object") return false;

  let changed = false;

  const pipes = Array.isArray(config.pipes) ? config.pipes : [];
  const entry = pipes.find(
    (p) => p.file === TARGET_FILE || p.render === TEMPLATE_RENDER,
  );

  if (!entry) {
    pipes.push({ file: TARGET_FILE, render: TEMPLATE_RENDER, mode: "pipe" });
    changed = true;
  } else {
    if (entry.file !== TARGET_FILE) {
      entry.file = TARGET_FILE;
      changed = true;
    }
    if (entry.render !== TEMPLATE_RENDER) {
      entry.render = TEMPLATE_RENDER;
      changed = true;
    }
    if (entry.mode !== "pipe") {
      entry.mode = "pipe";
      changed = true;
    }
  }
  config.pipes = pipes;

  if (changed && !dryRun) {
    try {
      fs.writeFileSync(cfgPath, stringifyYaml(config), "utf-8");
    } catch (err: unknown) {
      log.debug(`reconcileConfig write: ${errMsg(err)}`);
    }
  }
  return changed;
}

function installHermesHooks(
  cwd: string = process.cwd(),
  _delivery: DeliveryMode = "passive",
  dryRun: boolean = false,
  force: boolean = false,
): HookInstallResult {
  const results: string[] = [];
  let changed = false;

  // (1) Deploy / update the pipemd-context skill in $HOME.
  const sPath = skillPath();
  const body = skillBody();
  const exists = fs.existsSync(sPath);
  const same = exists && !force ? safeRead(sPath) === body : false;

  if (!exists || force || !same) {
    changed = true;
    if (!dryRun) {
      fs.mkdirSync(path.dirname(sPath), { recursive: true });
      fs.writeFileSync(sPath, body, "utf-8");
    }
    results.push(
      !exists
        ? "skill: installed \u2192 ~/.hermes/skills/devops/pipemd-context"
        : force
          ? "skill: updated (forced)"
          : "skill: updated",
    );
  } else {
    results.push("skill: already installed");
  }

  // (2) Reconcile config.yml (pipe entry).
  if (reconcileConfig(cwd, dryRun)) {
    changed = true;
    results.push("config: WORKSPACE_CONTEXT.md pipe ensured");
  } else {
    results.push("config: pipe entry already present");
  }

  const prefix = dryRun && changed ? "needs update: " : "";
  return {
    harness: "Hermes",
    installed: !dryRun && changed,
    mechanism: "skill+pipe",
    detail: prefix + results.join(" \u00b7 "),
  };
}

function removeHermesHooks(_cwd: string): HookInstallResult {
  const sPath = skillPath();
  let removed = false;
  let detail = "nothing to remove";

  try {
    const content = fs.readFileSync(sPath, "utf-8");
    if (!content.includes(PMD_MARKER)) {
      detail = "skill present but not pipemd-managed \u2014 left untouched";
    } else {
      try {
        fs.unlinkSync(sPath);
        removed = true;
        try {
          fs.rmSync(path.dirname(sPath), { recursive: true });
        } catch (err: unknown) {
          log.debug(`prune skill dir: ${errMsg(err)}`);
        }
        detail = "skill removed from ~/.hermes/skills/devops/pipemd-context";
      } catch (err: unknown) {
        log.debug(`removeHermesHooks unlink: ${errMsg(err)}`);
      }
    }
  } catch (err: unknown) {
    log.debug(`removeHermesHooks read: ${errMsg(err)}`);
  }

  return {
    harness: "Hermes",
    installed: removed,
    mechanism: "skill+pipe",
    detail,
  };
}

export const hermesAdapter: HarnessAdapter = {
  name: "Hermes",
  installHooks: installHermesHooks,
  removeHooks: removeHermesHooks,
};
