import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { renderContentAsync, parseCommand } from "./injector.js";
import { loadBase, composeContent, handleIncomingWrite } from "./daemon-write-back.js";
import { log, errMsg } from "./logger.js";
import { COMMAND_TIMEOUT_MS, DEFAULT_RESERVE_DELAY_MS } from "../config.js";
import type { PipeConfig } from "../config.js";
import { LIVE_DIR, STATUS_FILE, RENDERED_SNAPSHOT } from "./paths.js";
import { atomicWrite } from "./fs-utils.js";

const execFileAsync = promisify(execFile);

const ENXIO_MAX_RETRIES = 100;
const ENXIO_RETRY_WINDOW_MS = 60000;

const WRITE_BUFFER_DEBOUNCE_MS = 1000;

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
    execFileSync("mkfifo", [testPipe], { encoding: "utf-8", stdio: "pipe" });
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
  try { fs.unlinkSync(pipePath); } catch (err: unknown) { log.debug(`unlink pipe before mkfifo: ${errMsg(err)}`); }

  try {
    const dir = path.dirname(pipePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    execFileSync("mkfifo", [pipePath], { encoding: "utf-8" });
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
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), "utf-8");
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
        env: { ...process.env, ...cmdEnv },
      }).then(({ stdout }) => {
        const md = `\`\`\`\n${stdout.trimEnd()}\n\`\`\``;
        writeSafe(writeFd, md);
        closeSafe(writeFd);
        trackedSetTimeout(reServe, delay);
      }).catch((err: unknown) => {
        const e = err as { stderr?: string; message?: string };
        const detail = e.stderr?.trimEnd() || e.message || "Unknown error";
        writeSafe(writeFd, `\`\`\`\n⚠️ Command failed: ${cmd}\n${detail}\n\`\`\``);
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

export function getCachedRenderedContent(): string { return _cachedRenderedContent; }
export function setIsRendering(value: boolean): void { _isRendering = value; }
export function getIsRendering(): boolean { return _isRendering; }

async function updateCache(templatePath: string, config: PipeConfig) {
  if (_isRendering) return;
  _isRendering = true;
  try {
    const start = Date.now();
    const template = fs.readFileSync(templatePath, "utf-8");
    const rendered = await renderContentAsync(template, config);
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
  }
}

export function serveContextPipe(pipePath: string, templatePath: string, config: PipeConfig, writeBackGuard: { value: boolean }) {
  const delay = config.settings.reServeDelayMs ?? DEFAULT_RESERVE_DELAY_MS;

  trackedSetInterval(() => updateCache(templatePath, config), delay);
  updateCache(templatePath, config);

  try {
    const readFd = fs.openSync(pipePath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    const readStream = fs.createReadStream("", { fd: readFd, encoding: "utf-8" });

    contextStreamEntries.push({ fd: readFd, stream: readStream });

    let incomingBuffer = "";
    let incomingTimer: NodeJS.Timeout | null = null;

    readStream.on("data", (chunk: Buffer | string) => {
      incomingBuffer += chunk;
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

  const writeToPipe = () => {
    if (shuttingDown) return;
    if (writeBackGuard.value) {
      trackedSetTimeout(writeToPipe, delay);
      return;
    }

    try {
      const fd = fs.openSync(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
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

    trackedSetTimeout(writeToPipe, delay);
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
