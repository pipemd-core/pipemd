import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { renderContentAsync, parseCommand } from "./injector.js";
import { loadBase, composeContent, handleIncomingWrite } from "./daemon-write-back.js";
import { log, errMsg } from "./logger.js";
import { COMMAND_TIMEOUT_MS, DEFAULT_RESERVE_DELAY_MS } from "../config.js";
import type { PipeConfig } from "../config.js";
import { LIVE_DIR, STATUS_FILE, RENDERED_SNAPSHOT, BASE_PATH } from "./paths.js";
import { atomicWrite } from "./fs-utils.js";
import { buildSafeEnv } from "./json-utils.js";
import { getPmdVersion } from "./version.js";

const execFileAsync = promisify(execFile);

const ENXIO_MAX_RETRIES = 100;
const ENXIO_RETRY_WINDOW_MS = 60000;

const WRITE_BUFFER_DEBOUNCE_MS = 1000;
const WRITE_BUFFER_MAX_BYTES = 512 * 1024;
const RENDER_REQUEUE_DELAY_MS = 500;

// Slow-block tiering: these project-wide blocks shell out to expensive tools
// (tsc/eslint/ast-grep) that can take seconds. Running them on every 1s render
// tick blocks the whole loop and makes the cheap volatile blocks (git/tree/deps)
// stale. Instead they render on a separate, slower cadence and are cached in
// _slowResults between slow ticks so fast ticks stay sub-second.
const SLOW_BLOCK_NAMES = new Set(["lint", "type-check", "arch"]);
const SLOW_REFRESH_TICKS = 30;

// D2 — Idle backoff: when no reader has been seen for IDLE_THRESHOLD_MS,
// slow the render cadence to IDLE_RENDER_DELAY_MS (30s). The write loop's
// exponential backoff (D3) complements this. When a reader reappears, both
// loops snap back to fast cadence and trigger an immediate render.
const IDLE_THRESHOLD_MS = 60_000;
const IDLE_RENDER_DELAY_MS = 30_000;

// D1 — Input signature: a cheap proxy for "has anything the render pipeline
// cares about changed?" Computed from stat calls + one cached `git status`
// (5s TTL). If the signature matches the last render, skip the full pipeline
// (which spawns N bash processes) entirely.
const GIT_STATUS_TTL_MS = 5_000;
const _gitStatusCache = { value: "\0", ts: 0 };
let _lastInputSignature = "";

// D2 — Reader tracking: updated whenever writeToPipe or serveCommandPipe
// successfully opens the FIFO for writing (i.e., a reader is present).
let _lastReaderSeen = Date.now();

function computeInputSignature(templatePath: string, config: PipeConfig): string {
  const parts: string[] = [];
  try {
    const s = fs.statSync(templatePath);
    parts.push(`tpl:${s.mtimeMs}:${s.size}`);
  } catch { parts.push("tpl:?"); }
  const basePath = config.base || BASE_PATH;
  try {
    const s = fs.statSync(basePath);
    parts.push(`base:${s.mtimeMs}:${s.size}`);
  } catch { parts.push("base:?"); }
  const now = Date.now();
  if (now - _gitStatusCache.ts > GIT_STATUS_TTL_MS) {
    try {
      _gitStatusCache.value = execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf-8", timeout: 2000, cwd: process.cwd(),
      }).trim();
    } catch {
      _gitStatusCache.value = "no-git";
    }
    _gitStatusCache.ts = now;
  }
  parts.push(`git:${_gitStatusCache.value}`);
  parts.push(`slow:${Math.floor(_slowTick / SLOW_REFRESH_TICKS)}`);
  return parts.join("|");
}

function isIdle(): boolean {
  return Date.now() - _lastReaderSeen > IDLE_THRESHOLD_MS;
}

function getRenderDelay(baseDelay: number): number {
  return isIdle() ? Math.max(baseDelay, IDLE_RENDER_DELAY_MS) : baseDelay;
}

const activeTimeouts: NodeJS.Timeout[] = [];
const activeIntervals: NodeJS.Timer[] = [];
const contextStreamEntries: { fd: number; stream: fs.ReadStream }[] = [];

let shuttingDown = false;

export function setShuttingDown(value: boolean) {
  shuttingDown = value;
}

export function trackedSetTimeout(fn: () => void, ms: number): NodeJS.Timeout {
  const id = setTimeout(() => {
    const idx = activeTimeouts.indexOf(id);
    if (idx >= 0) activeTimeouts.splice(idx, 1);
    fn();
  }, ms);
  activeTimeouts.push(id);
  return id;
}

export function trackedSetInterval(fn: () => void, ms: number): NodeJS.Timer {
  const id = setInterval(fn, ms);
  activeIntervals.push(id);
  return id;
}

export function trackedClearTimeout(id: NodeJS.Timeout) {
  clearTimeout(id);
  const idx = activeTimeouts.indexOf(id);
  if (idx >= 0) activeTimeouts.splice(idx, 1);
}

export function checkMkfifo(): boolean {
  try {
    const testPipe = path.join(LIVE_DIR, ".pmd-mkfifo-test");
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    execFileSync("mkfifo", [testPipe, "-m", "0600"], { encoding: "utf-8", stdio: "pipe" });
    fs.unlinkSync(testPipe);
    return true;
  } catch (err: unknown) {
    log.debug(`checkMkfifo failed: ${errMsg(err)}`);
    return false;
  }
}

export function resolvePipePath(pipeFile: string, pipe: { render?: string; command?: string }): string {
  if (pipe.render) {
    return pipeFile;
  }
  return path.join(LIVE_DIR, pipeFile);
}

export function createPipe(pipePath: string): boolean {
  try {
    const dir = path.dirname(pipePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try { fs.chmodSync(dir, 0o700); } catch (err: unknown) { log.debug(`createPipe dir chmod: ${errMsg(err)}`); }

    const tempPipe = pipePath + `.tmp-${crypto.randomBytes(8).toString("hex")}`;
    try { fs.unlinkSync(tempPipe); } catch (err: unknown) { log.debug(`unlink temp pipe: ${errMsg(err)}`); }
    execFileSync("mkfifo", [tempPipe, "-m", "0600"], { encoding: "utf-8" });

    const tempStat = fs.statSync(tempPipe);
    if (!tempStat.isFIFO()) {
      log.warn(`createPipe: temp pipe ${tempPipe} is not a FIFO — aborting.`);
      try { fs.unlinkSync(tempPipe); } catch {}
      return false;
    }

    try { fs.renameSync(tempPipe, pipePath); }
    catch (err: unknown) {
      log.debug(`createPipe rename failed, falling back to unlink+mkfifo: ${errMsg(err)}`);
      try { fs.unlinkSync(tempPipe); } catch {}
      try { fs.unlinkSync(pipePath); } catch (err: unknown) { log.debug(`unlink pipe before mkfifo: ${errMsg(err)}`); }
      execFileSync("mkfifo", [pipePath, "-m", "0600"], { encoding: "utf-8" });
    }

    const finalStat = fs.statSync(pipePath);
    if (!finalStat.isFIFO()) {
      log.warn(`createPipe: ${pipePath} is not a FIFO after creation — removing.`);
      try { fs.unlinkSync(pipePath); } catch {}
      return false;
    }
    fs.chmodSync(pipePath, 0o600);
    log.info(`Created pipe: ${pipePath}`);
    return true;
  } catch (err: unknown) {
    const msg = errMsg(err);
    log.warn(`Could not create pipe ${pipePath}: ${msg}`);
    return false;
  }
}

function writeSafe(writeFd: number, data: string): boolean {
  try {
    fs.writeSync(writeFd, data);
    return true;
  } catch (err: unknown) {
    if (isEpipe(err)) {
      log.info("Reader closed pipe early (EPIPE). Re-serving.");
      return false;
    }
    throw err;
  }
}

export function updateStatus(status: {
  lastRun: string;
  durationMs: number;
  error?: string | null;
  renderedBytes?: number;
}) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...status, version: getPmdVersion() }, null, 2), "utf-8");
  } catch (err) {
    log.error(`Error updating status file: ${err}`);
  }
}

function closeSafe(writeFd: number) {
  try {
    fs.closeSync(writeFd);
  } catch (err: unknown) {
    if (!isEpipe(err)) {
      log.error(`Error closing pipe fd: ${err}`);
    }
  }
}

export function isEpipe(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const msg = err.message || "";
    return code === "EPIPE" || msg.includes("EPIPE");
  }
  if (typeof err === "string") {
    return err.includes("EPIPE");
  }
  return false;
}

export function serveCommandPipe(pipePath: string, command: string, config: PipeConfig) {
  const cmd = config.commands[command];
  if (!cmd) {
    log.warn(`No command mapping for pipe: ${command}`);
    return;
  }

  const delay = config.settings.reServeDelayMs ?? DEFAULT_RESERVE_DELAY_MS;
  let enxioCount = 0;
  let enxioWindowStart = Date.now();

  const reServe = () => {
    if (shuttingDown) return;

    fs.open(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK, (openErr, writeFd) => {
      if (openErr) {
        if (openErr.code === 'ENXIO') {
          const now = Date.now();
          if (now - enxioWindowStart > ENXIO_RETRY_WINDOW_MS) {
            enxioCount = 0;
            enxioWindowStart = now;
          }
          enxioCount++;
          if (enxioCount > ENXIO_MAX_RETRIES) {
            log.warn(`Max ENXIO retries (${ENXIO_MAX_RETRIES}) for ${pipePath}. Backing off.`);
            enxioCount = 0;
            trackedSetTimeout(reServe, delay * 5);
            return;
          }
          trackedSetTimeout(reServe, delay);
          return;
        }
        log.error(`Open error: ${openErr.message}`);
        return;
      }
      enxioCount = 0;
      if (shuttingDown) {
        closeSafe(writeFd);
        return;
      }

      const { bin, args: binArgs, env: cmdEnv } = parseCommand(cmd);
      const timeout = config.commandTimeouts?.[command] ?? COMMAND_TIMEOUT_MS;
      execFileAsync(bin, binArgs, {
        encoding: "utf-8",
        timeout,
        cwd: process.cwd(),
        env: buildSafeEnv(cmdEnv),
      }).then(({ stdout }) => {
        const md = `\`\`\`\n${stdout.trimEnd()}\n\`\`\``;
        writeSafe(writeFd, md);
        closeSafe(writeFd);
        trackedSetTimeout(reServe, delay);
      }).catch((err: unknown) => {
        const e = err as { stderr?: string; killed?: boolean; signal?: string };
        if (!(e.killed || e.signal === "SIGTERM")) {
          const detail = e.stderr?.trimEnd() || errMsg(err);
          log.warn(`pipe '${command}' suppressed after error: ${detail}`);
        }
        writeSafe(writeFd, "");
        closeSafe(writeFd);
        trackedSetTimeout(reServe, delay);
      });
    });
  };

  reServe();
  log.info(`Serving pipe: ${pipePath} (${command})`);
}

let _cachedRenderedContent: string = "";
let _isRendering = false;
let _renderPending = false;
let _slowTick = 0;
const _slowResults = new Map<string, string>();

export function getCachedRenderedContent(): string { return _cachedRenderedContent; }
export function setIsRendering(value: boolean): void { _isRendering = value; }
export function getIsRendering(): boolean { return _isRendering; }

async function updateCache(templatePath: string, config: PipeConfig) {
  if (_isRendering) {
    _renderPending = true;
    return;
  }

  // D1 — Content-hash gate: if the inputs haven't changed since the last
  // render, skip the entire pipeline (which spawns N bash processes).
  // The signature includes template/base mtimes, a cached `git status` (5s
  // TTL), and the slow-tier epoch. This eliminates >99% of wasted renders
  // between tool calls where nothing in the project has changed.
  const sig = computeInputSignature(templatePath, config);
  if (sig === _lastInputSignature) {
    return;
  }
  _lastInputSignature = sig;

  _isRendering = true;
  _renderPending = false;
  try {
    const start = Date.now();
    const template = fs.readFileSync(templatePath, "utf-8");
    // Slow-tier cadence: clear the slow-block cache every Nth tick so those
    // expensive blocks re-run; in between they're served from cache and the
    // fast blocks render on the normal cadence.
    _slowTick++;
    if (_slowTick % SLOW_REFRESH_TICKS === 0) {
      _slowResults.clear();
    }
    const rendered = await renderContentAsync(template, config, undefined, SLOW_BLOCK_NAMES, _slowResults);
    const base = loadBase(config);
    _cachedRenderedContent = composeContent(base, rendered);
    try { atomicWrite(RENDERED_SNAPSHOT, _cachedRenderedContent); }
    catch (err: unknown) { log.warn(`snapshot write failed: ${errMsg(err)}`); }
    log.info("Cache updated");
    updateStatus({
      lastRun: new Date().toISOString(),
      durationMs: Date.now() - start,
      renderedBytes: Buffer.byteLength(_cachedRenderedContent, "utf-8"),
    });
  } catch (err: unknown) {
    const msg = errMsg(err);
    log.error(`Error rendering context: ${msg}`);
    updateStatus({ lastRun: new Date().toISOString(), durationMs: 0, error: msg });
  } finally {
    _isRendering = false;
    if (_renderPending) {
      trackedSetTimeout(() => updateCache(templatePath, config), RENDER_REQUEUE_DELAY_MS);
    }
  }
}

export function serveContextPipe(pipePath: string, templatePath: string, config: PipeConfig, writeBackGuard: { value: boolean }) {
  const baseDelay = config.settings.reServeDelayMs ?? DEFAULT_RESERVE_DELAY_MS;

  // D2 — Adaptive render cadence: recursive setTimeout that checks
  // getRenderDelay() each tick. When idle (no reader for 60s), backs off
  // to 30s. When active, stays at the configured baseDelay (1s default).
  const scheduleRender = () => {
    if (shuttingDown) return;
    const delay = getRenderDelay(baseDelay);
    trackedSetTimeout(() => {
      updateCache(templatePath, config);
      scheduleRender();
    }, delay);
  };
  updateCache(templatePath, config);
  scheduleRender();

  try {
    const readFd = fs.openSync(pipePath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    const readStream = fs.createReadStream("", { fd: readFd, encoding: "utf-8" });

    contextStreamEntries.push({ fd: readFd, stream: readStream });

    let incomingBuffer = "";
    let incomingTimer: NodeJS.Timeout | null = null;

    readStream.on("data", (chunk: Buffer | string) => {
      incomingBuffer += chunk;
      if (incomingBuffer.length > WRITE_BUFFER_MAX_BYTES) {
        log.warn(`Write-back buffer exceeded ${WRITE_BUFFER_MAX_BYTES} bytes — discarding (possible stuck writer)`);
        incomingBuffer = "";
        if (incomingTimer) { trackedClearTimeout(incomingTimer); incomingTimer = null; }
        return;
      }
      if (incomingTimer) trackedClearTimeout(incomingTimer);
      incomingTimer = trackedSetTimeout(() => {
        const data = incomingBuffer;
        incomingBuffer = "";
        incomingTimer = null;
        if (data.trim()) {
          handleIncomingWrite(data, templatePath, config, writeBackGuard);
        }
      }, WRITE_BUFFER_DEBOUNCE_MS);
    });

    readStream.on("error", (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return;
      log.warn(`ReadStream error on context pipe: ${err.message}`);
    });

    log.info(`Listening for AI writes on context pipe (bidirectional mode): ${pipePath}`);
  } catch (err: unknown) {
    const msg = errMsg(err);
    log.warn(`Could not attach ReadStream to context pipe: ${msg}. Write-back disabled for this pipe.`);
  }

  // D3 — FIFO write pump with exponential backoff. When no reader is
  // present (ENXIO), back off progressively to reduce syscall churn. When
  // a reader opens, reset to fast cadence and mark _lastReaderSeen so the
  // render loop (D2) also snaps back to fast cadence.
  const WRITE_BACKOFF_STEPS = [1000, 2000, 5000, 10_000];
  let writeBackoffIdx = 0;

  const writeToPipe = () => {
    if (shuttingDown) return;
    if (writeBackGuard.value) {
      trackedSetTimeout(writeToPipe, baseDelay);
      return;
    }

    let readerPresent = false;
    try {
      const fd = fs.openSync(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      readerPresent = true;
      try {
        if (_cachedRenderedContent) {
          writeSafe(fd, _cachedRenderedContent);
        }
      } finally {
        closeSafe(fd);
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENXIO') {
        const msg = errMsg(err);
        log.warn(`Write failed: ${msg}`);
      }
    }

    if (readerPresent) {
      _lastReaderSeen = Date.now();
      writeBackoffIdx = 0;
    } else {
      writeBackoffIdx = Math.min(writeBackoffIdx + 1, WRITE_BACKOFF_STEPS.length - 1);
    }

    const nextDelay = readerPresent
      ? baseDelay
      : WRITE_BACKOFF_STEPS[writeBackoffIdx];
    trackedSetTimeout(writeToPipe, nextDelay);
  };

  writeToPipe();
  log.info(`Serving context pipe: ${pipePath} ← ${templatePath}`);
}

export function shutdownPipes() {
  for (const id of activeTimeouts) {
    try { clearTimeout(id); } catch (err: unknown) { log.debug(`shutdown clearTimeout failed: ${errMsg(err)}`); }
  }
  activeTimeouts.length = 0;

  for (const id of activeIntervals) {
    try { clearInterval(id as unknown as NodeJS.Timeout); } catch (err: unknown) { log.debug(`shutdown clearInterval failed: ${errMsg(err)}`); }
  }
  activeIntervals.length = 0;

  for (const entry of contextStreamEntries) {
    try { entry.stream.destroy(); } catch (err: unknown) { log.debug(`shutdown stream.destroy failed: ${errMsg(err)}`); }
    try { fs.closeSync(entry.fd); } catch (err: unknown) { log.debug(`shutdown closeSync failed: ${errMsg(err)}`); }
  }
  contextStreamEntries.length = 0;
}
