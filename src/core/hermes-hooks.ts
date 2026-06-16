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
const RELAY_CONFIG_NAME = "relay.json";
const RELAY_TOKEN_REL = path.join(".pipemd", "link", "relay.token");

/** Marker written into the skill body so removeHooks can detect our install. */
const PMD_MARKER = "<!-- pipemd-managed-skill -->";

function hermesSkillsDir(): string {
  return path.join(os.homedir(), ".hermes", "skills", SKILL_CATEGORY);
}

function skillPath(): string {
  return path.join(hermesSkillsDir(), SKILL_NAME, "SKILL.md");
}

function relayPath(): string {
  return path.join(hermesSkillsDir(), SKILL_NAME, RELAY_CONFIG_NAME);
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
 * the only Hermes-specific artifact. Covers three concerns:
 *   1. Reading context (WORKSPACE_CONTEXT.md FIFO via cat + pmd run fallback).
 *   2. Crew coordination (register, claim, heartbeat, leave).
 *   3. Fleet awareness — see and drive the fleet through the relay (pull-based).
 */
function skillBody(): string {
  return [
    "---",
    "name: pipemd-context",
    "description: PipeMD context for Hermes. Read WORKSPACE_CONTEXT.md for live project",
    "  context, register as a crew coordinator, claim files, and drive the fleet",
    "  through the relay.",
    "version: 2.0.0",
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
    "## Fleet — see and drive the relay fabric",
    "",
    "Your relay endpoint and bearer token are written to:",
    "  ~/.hermes/skills/devops/pipemd-context/relay.json",
    "Read that file first to resolve the concrete {relay} base URL and token.",
    "All requests require: Authorization: Bearer <token> (from relay.json).",
    "",
    "DECISION RULE — always start pull-based: read the fleet topology first, then",
    "act. Never push state; the relay (Track B) is the fabric, Hermes is a",
    "pull-based consumer + commander.",
    "",
    "See the fleet (build your topology model before acting):",
    "  GET {relay}/fleet",
    "Returns all machines, their projects, active sessions/agents, and PTYs.",
    "",
    "Read a specific worker's live context:",
    "  GET {relay}/workspace/:agent_id/context",
    "Use this to inspect what a coding agent currently sees.",
    "",
    "Dispatch a task to a specific session:",
    "  POST {relay}/fleet/:machine/session/:id/message",
    "Body: { \"message\": \"refactor the auth module\" }",
    "",
    "Take the hand — connect to a worker's PTY interactively:",
    "  POST {relay}/fleet/:machine/pty/:ptyID/takeover",
    "The response returns a relay WebSocket URL. Connect to it with `cursor` to",
    "stream and resume the session. This REPLACES manual SSH + tmux.",
    "",
    PMD_MARKER,
    "",
  ].join("\n");
}

/**
 * Read the relay base URL and bearer token from Empire secure config:
 *   - URL:  PMD_RELAY env var, or config.yml `link.relay`.
 *   - Token: ~/.pipemd/link/relay.token (generated by `pmd link`).
 * Returns null when no relay URL is configured. Never hardcodes host/secret.
 * Exported so fleet-summary.ts reuses the same source of truth (self-review N8).
 */
export function readRelayInfo(cwd: string): { baseUrl: string; token: string } | null {
  let baseUrl = process.env.PMD_RELAY || "";
  if (!baseUrl) {
    try {
      const cfgPath = path.join(cwd, CONFIG_REL);
      if (fs.existsSync(cfgPath)) {
        const config = parseYaml(fs.readFileSync(cfgPath, "utf-8")) as
          | { link?: { relay?: string } }
          | null;
        baseUrl = config?.link?.relay || "";
      }
    } catch (err: unknown) {
      log.debug(`readRelayInfo url: ${errMsg(err)}`);
    }
  }
  if (!baseUrl) return null;

  let token = "";
  try {
    const tokenFile = path.join(os.homedir(), RELAY_TOKEN_REL);
    if (fs.existsSync(tokenFile)) {
      token = fs.readFileSync(tokenFile, "utf-8").trim();
    }
  } catch (err: unknown) {
    log.debug(`readRelayInfo token: ${errMsg(err)}`);
  }

  return { baseUrl, token };
}

/**
 * Idempotently write the relay endpoint + token into
 * `~/.hermes/skills/devops/pipemd-context/relay.json` (chmod 0o600) so the
 * skill's Fleet instructions resolve to a concrete endpoint (A2-2).
 * Returns whether a change was (or would be, under dryRun) made.
 */
function reconcileRelayConfig(
  cwd: string,
  dryRun: boolean,
): { changed: boolean; detail: string } {
  const info = readRelayInfo(cwd);
  if (!info) {
    return { changed: false, detail: "relay: not configured (skipped)" };
  }

  const rPath = relayPath();
  const content =
    JSON.stringify({ baseUrl: info.baseUrl, token: info.token }, null, 2) + "\n";
  const exists = fs.existsSync(rPath);
  const same = exists ? safeRead(rPath) === content : false;

  if (same) {
    return { changed: false, detail: "relay: config already present" };
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(rPath), { recursive: true });
    fs.writeFileSync(rPath, content, "utf-8");
    try {
      fs.chmodSync(rPath, 0o600);
    } catch (err: unknown) {
      log.debug(`reconcileRelayConfig chmod: ${errMsg(err)}`);
    }
  }
  return {
    changed: true,
    detail: exists ? "relay: config updated" : "relay: config written",
  };
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

  // (3) Reconcile relay endpoint config (A2-2).
  const relayResult = reconcileRelayConfig(cwd, dryRun);
  if (relayResult.changed) changed = true;
  results.push(relayResult.detail);

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
