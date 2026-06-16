import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { DeliveryMode } from "./injection-types.js";
import type { HookInstallResult, HarnessAdapter } from "./hooks.js";
import { log, errMsg } from "./logger.js";

const TARGET_FILE = "WORKSPACE_CONTEXT.md";
const MARKER_DIR = ".hermes";
const MARKER_FILE = path.join(MARKER_DIR, "pipemd-context.json");
const BAK_SUFFIX = ".pipemd.bak";

declare const PKG_VERSION: string | undefined;

function adapterVersion(): string {
  return typeof PKG_VERSION === "string" ? PKG_VERSION : "0.0.0-adapter";
}

function isFifo(p: string): boolean {
  try {
    return fs.statSync(p).isFIFO();
  } catch {
    return false;
  }
}

function checkMkfifo(): boolean {
  try {
    execFileSync("which", ["mkfifo"], { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch (err: unknown) {
    log.debug(`checkMkfifo failed: ${errMsg(err)}`);
    return false;
  }
}

function createPipe(pipePath: string): boolean {
  try { fs.unlinkSync(pipePath); } catch (err: unknown) { log.debug(`unlink pipe before mkfifo: ${errMsg(err)}`); }
  try {
    const dir = path.dirname(pipePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    execFileSync("mkfifo", [pipePath], { encoding: "utf-8" });
    fs.chmodSync(pipePath, 0o600);
    log.info(`Created pipe: ${pipePath}`);
    return true;
  } catch (err: unknown) {
    log.warn(`Could not create pipe ${pipePath}: ${errMsg(err)}`);
    return false;
  }
}

function writeMarker(cwd: string, delivery: DeliveryMode, dryRun: boolean): string | null {
  const markerPath = path.join(cwd, MARKER_FILE);
  try {
    const content = JSON.stringify({
      target: TARGET_FILE,
      mechanism: "pipe",
      delivery,
      version: adapterVersion(),
    }, null, 2) + "\n";
    if (!dryRun) {
      const dir = path.dirname(markerPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(markerPath, content, "utf-8");
    }
    return content;
  } catch (err: unknown) {
    log.debug(`writeMarker failed: ${errMsg(err)}`);
    return null;
  }
}

function installHermesHooks(
  cwd: string = process.cwd(),
  delivery: DeliveryMode = "passive",
  dryRun: boolean = false,
  _force: boolean = false,
): HookInstallResult {
  const pipePath = path.join(cwd, TARGET_FILE);
  const results: string[] = [];

  if (dryRun) {
    return {
      harness: "Hermes",
      installed: false,
      mechanism: "pipe",
      detail: "needs install: would create WORKSPACE_CONTEXT.md pipe",
      injectionMode: delivery === "active" || delivery === "expert" ? delivery : undefined,
    };
  }

  // If a regular (non-pipe) file is at the target, back it up before replacing with a pipe.
  if (fs.existsSync(pipePath) && !isFifo(pipePath)) {
    const bak = pipePath + BAK_SUFFIX;
    try {
      fs.copyFileSync(pipePath, bak);
      results.push("backed up existing WORKSPACE_CONTEXT.md");
    } catch (err: unknown) {
      log.debug(`backup of ${pipePath} failed: ${errMsg(err)}`);
    }
  }

  if (!isFifo(pipePath)) {
    if (!checkMkfifo()) {
      return {
        harness: "Hermes",
        installed: false,
        mechanism: "instruction",
        detail: "mkfifo unavailable — no edit-event API, uses injected Coordination Protocol",
      };
    }
    if (!createPipe(pipePath)) {
      return {
        harness: "Hermes",
        installed: false,
        mechanism: "error",
        detail: "could not create WORKSPACE_CONTEXT.md pipe",
      };
    }
    results.push("pipe: created WORKSPACE_CONTEXT.md");
  } else {
    results.push("pipe: already installed");
  }

  if (writeMarker(cwd, delivery, dryRun)) {
    results.push("marker: written");
  }

  return {
    harness: "Hermes",
    installed: isFifo(pipePath),
    mechanism: "pipe",
    detail: results.join(" \u00b7 "),
    injectionMode: delivery === "active" || delivery === "expert" ? delivery : undefined,
  };
}

function removeHermesHooks(cwd: string): HookInstallResult {
  const results: string[] = [];
  let removed = false;
  const pipePath = path.join(cwd, TARGET_FILE);
  const markerPath = path.join(cwd, MARKER_FILE);
  const bakPath = pipePath + BAK_SUFFIX;

  // Only ever remove a FIFO. Never delete a hand-written regular file.
  if (fs.existsSync(pipePath) && isFifo(pipePath)) {
    try {
      fs.unlinkSync(pipePath);
      results.push("pipe: removed WORKSPACE_CONTEXT.md");
      removed = true;
    } catch (err: unknown) {
      log.debug(`unlink pipe failed: ${errMsg(err)}`);
    }
  }

  if (fs.existsSync(markerPath)) {
    try {
      fs.unlinkSync(markerPath);
      results.push("marker: removed");
      removed = true;
    } catch (err: unknown) {
      log.debug(`unlink marker failed: ${errMsg(err)}`);
    }
  }

  // Restore the backed-up regular file, if any.
  if (fs.existsSync(bakPath)) {
    try {
      fs.renameSync(bakPath, pipePath);
      results.push("restored WORKSPACE_CONTEXT.md from backup");
    } catch (err: unknown) {
      log.debug(`restore backup failed: ${errMsg(err)}`);
    }
  }

  return {
    harness: "Hermes",
    installed: removed,
    mechanism: "pipe",
    detail: results.length ? results.join(" \u00b7 ") : "nothing to remove",
  };
}

export const hermesAdapter: HarnessAdapter = {
  name: "Hermes",
  installHooks: installHermesHooks,
  removeHooks: removeHermesHooks,
};
