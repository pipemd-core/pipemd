import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import chokidar from "chokidar";
import YAML from "yaml";
import { injectFile, renderContentAsync, reverseInject } from "./injector.js";
import { reapStaleSessions, DEFAULT_STALE_MS } from "./crew.js";
import { writeDashboard, resetDaemonStart } from "./dashboard.js";
import { ensureCacheDir } from "./cache.js";
import { purgeOldRecords } from "./dedup.js";
import { log } from "./logger.js";
import { COMMAND_TIMEOUT_MS, PMD_CONTEXT_SEPARATOR } from "../config.js";
import type { PipeConfig, PipeMode } from "../config.js";
import { PIPEMD_DIR, LIVE_DIR, PID_FILE, STATUS_FILE, CONFIG_PATH, INJECTION_LOG_DIR } from "./paths.js";

const WRITE_BUFFER_DEBOUNCE_MS = 1000;
const INJECTION_LOG_MAX_AGE_MS = 3_600_000;

function cleanInjectionLog(maxAgeMs: number = INJECTION_LOG_MAX_AGE_MS): void {
  if (!fs.existsSync(INJECTION_LOG_DIR)) return;
  const now = Date.now();
  let entries: string[];
  try {
    entries = fs.readdirSync(INJECTION_LOG_DIR);
  } catch {
    return;
  }
  for (const file of entries) {
    if (file === "last.txt") continue;
    const fullPath = path.join(INJECTION_LOG_DIR, file);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fullPath);
      }
    } catch {}
  }
}

let shuttingDown = false;

const ENXIO_MAX_RETRIES = 100;
const ENXIO_RETRY_WINDOW_MS = 60000;

const activeTimers: unknown[] = [];
const contextStreamEntries: { fd: number; stream: fs.ReadStream }[] = [];

function trackedSetTimeout(fn: () => void, ms: number): NodeJS.Timeout {
  const id = setTimeout(() => {
    const idx = activeTimers.indexOf(id);
    if (idx >= 0) activeTimers.splice(idx, 1);
    fn();
  }, ms);
  activeTimers.push(id);
  return id;
}

function trackedSetInterval(fn: () => void, ms: number): NodeJS.Timer {
  const id = setInterval(fn, ms);
  activeTimers.push(id);
  return id;
}

function trackedClearTimeout(id: NodeJS.Timeout) {
  clearTimeout(id);
  const idx = activeTimers.indexOf(id);
  if (idx >= 0) activeTimers.splice(idx, 1);
}

function validateConfig(raw: unknown): PipeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    log.error("Invalid config.yml: expected a mapping (object), got " + (raw === null ? "null" : typeof raw));
    process.exit(1);
  }

  const cfg = raw as Record<string, unknown>;

  if (!cfg.commands || typeof cfg.commands !== "object" || Array.isArray(cfg.commands)) {
    if (cfg.commands === undefined || cfg.commands === null) {
      log.error("Invalid config.yml: missing 'commands' — nothing to render. Run `pmd init` to regenerate.");
      process.exit(1);
    }
    log.error("Invalid config.yml: 'commands' must be a mapping of name → shell command");
    process.exit(1);
  }

  if (cfg.pipes !== undefined && cfg.pipes !== null) {
    if (!Array.isArray(cfg.pipes)) {
      log.error("Invalid config.yml: 'pipes' must be an array");
      process.exit(1);
    }
  } else {
    cfg.pipes = [];
  }

  if (cfg.injected !== undefined && cfg.injected !== null) {
    if (!Array.isArray(cfg.injected)) {
      log.error("Invalid config.yml: 'injected' must be an array");
      process.exit(1);
    }
  } else {
    cfg.injected = [];
  }

  if (!cfg.settings || typeof cfg.settings !== "object" || Array.isArray(cfg.settings)) {
    cfg.settings = {};
  }
  const settings = cfg.settings as Record<string, unknown>;
  if (typeof settings.debounceMs !== "number") {
    settings.debounceMs = 3000;
  }
  if (typeof settings.reServeDelayMs !== "number") {
    settings.reServeDelayMs = 1000;
  }
  if (typeof settings.tokenProfile !== "string") {
    settings.tokenProfile = "medium";
  }

  return cfg as unknown as PipeConfig;
}

function loadConfig(): PipeConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = YAML.parse(raw);
    return validateConfig(parsed);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      log.error("Config file not found. Run `pmd init` first.");
    } else {
      log.error("Config file invalid. " + (err instanceof Error ? err.message : String(err)));
    }
    process.exit(1);
  }
}

function checkMkfifo(): boolean {
  try {
    const testPipe = path.join(LIVE_DIR, ".pmd-mkfifo-test");
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    execFileSync("mkfifo", [testPipe], { encoding: "utf-8", stdio: "pipe" });
    fs.unlinkSync(testPipe);
    return true;
  } catch {
    return false;
  }
}

function resolvePipePath(pipeFile: string, pipe: { render?: string; command?: string }): string {
  if (pipe.render) {
    return pipeFile;
  }
  return path.join(LIVE_DIR, pipeFile);
}

function createPipe(pipePath: string): boolean {
  try { fs.unlinkSync(pipePath); } catch {}

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
    const msg = err instanceof Error ? err.message : String(err);
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

function updateStatus(status: {
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

function isEpipe(err: unknown): boolean {
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

function serveCommandPipe(pipePath: string, command: string, config: PipeConfig) {
  const cmd = config.commands[command];
  if (!cmd) {
    log.warn(`No command mapping for pipe: ${command}`);
    return;
  }

  const delay = config.settings.reServeDelayMs ?? 2000;
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

      try {
        const output = execSync(cmd, {
          encoding: "utf-8",
          timeout: COMMAND_TIMEOUT_MS,
          cwd: process.cwd(),
        }).trimEnd();

        const md = `\`\`\`\n${output}\n\`\`\``;
        writeSafe(writeFd, md);
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string };
        const detail = e.stderr?.trimEnd() || e.message || "Unknown error";
        writeSafe(writeFd, `\`\`\`\n⚠️ Command failed: ${cmd}\n${detail}\n\`\`\``);
      } finally {
        closeSafe(writeFd);
      }

      trackedSetTimeout(reServe, delay);
    });
  };

  reServe();
  log.info(`Serving pipe: ${pipePath} (${command})`);
}

let cachedRenderedContent: string = "";
let isRendering = false;
let writeBackInProgress = false;

function loadBase(config: PipeConfig): string {
  if (!config.base) return "";
  try {
    return fs.readFileSync(config.base, "utf-8").trimEnd();
  } catch {
    return "";
  }
}

function composeContent(base: string, renderedTemplate: string): string {
  if (!base) return renderedTemplate;
  return base + PMD_CONTEXT_SEPARATOR + renderedTemplate;
}

function splitContextContent(content: string): { base: string; template: string } {
  const idx = content.indexOf("<!-- pmd-context -->");
  if (idx === -1) {
    return { base: "", template: content };
  }
  const base = content.slice(0, idx).replace(/\n*---\n*$/, "").trimEnd();
  const template = content.slice(idx + "<!-- pmd-context -->".length).trimStart();
  return { base, template };
}

function handleIncomingWrite(data: string, templatePath: string, config: PipeConfig) {
  if (writeBackInProgress) return;
  writeBackInProgress = true;
  try {
    const { base: newBase, template: templatePortion } = splitContextContent(data);
    const currentBase = loadBase(config);

    if (newBase && newBase !== currentBase && config.base) {
      try {
        const tmpPath = config.base + ".tmp";
        fs.writeFileSync(tmpPath, newBase + "\n", "utf-8");
        fs.renameSync(tmpPath, config.base);
        log.info("Base instructions updated from AI write-back");
      } catch (baseErr: unknown) {
        const msg = baseErr instanceof Error ? baseErr.message : String(baseErr);
        log.error(`Error saving base file: ${msg}`);
      }
    }

    const template = fs.readFileSync(templatePath, "utf-8");
    const contentToDeRender = templatePortion || data;
    const deRendered = reverseInject(contentToDeRender, template);
    if (deRendered !== template) {
      const tmpPath = templatePath + ".tmp";
      try {
        fs.writeFileSync(tmpPath, deRendered, "utf-8");
        fs.renameSync(tmpPath, templatePath);
      } catch (writeErr) {
        try { fs.unlinkSync(tmpPath); } catch {}
        throw writeErr;
      }
      log.info("De-rendered AI write-back → template.md updated");
      const changed = injectFile(templatePath, config);
      if (changed) {
        log.info("Re-injected template after write-back");
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Error processing AI write-back: ${msg}`);
  } finally {
    writeBackInProgress = false;
  }
}

async function updateCache(templatePath: string, config: PipeConfig) {
  if (isRendering) return;
  isRendering = true;
  try {
    const start = Date.now();
    const template = fs.readFileSync(templatePath, "utf-8");
    const rendered = await renderContentAsync(template, config);
    const base = loadBase(config);
    cachedRenderedContent = composeContent(base, rendered);
    log.info("Cache updated");
    // Record the rendered byte count: in pipe mode the context files are FIFOs
    // (statSync reports size 0), so a stat-based token estimate is impossible.
    // Consumers like the OpenCode TUI panel read renderedBytes from here instead.
    updateStatus({
      lastRun: new Date().toISOString(),
      durationMs: Date.now() - start,
      renderedBytes: Buffer.byteLength(cachedRenderedContent, "utf-8"),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Error rendering context: ${msg}`);
    updateStatus({ lastRun: new Date().toISOString(), durationMs: 0, error: msg });
  } finally {
    isRendering = false;
  }
}

function serveContextPipe(pipePath: string, templatePath: string, config: PipeConfig) {
  const delay = config.settings.reServeDelayMs ?? 2000;

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
          handleIncomingWrite(data, templatePath, config);
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
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Could not attach ReadStream to context pipe: ${msg}. Write-back disabled for this pipe.`);
  }

  const writeToPipe = () => {
    if (shuttingDown) return;
    if (writeBackInProgress) {
      trackedSetTimeout(writeToPipe, delay);
      return;
    }

    try {
      const fd = fs.openSync(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      try {
        if (cachedRenderedContent) {
          writeSafe(fd, cachedRenderedContent);
        }
      } finally {
        closeSafe(fd);
      }
    } catch (err: any) {
      if (err.code !== 'ENXIO') {
        log.warn(`Write failed: ${err.message}`);
      }
    }

    trackedSetTimeout(writeToPipe, delay);
  };

  writeToPipe();
  log.info(`Serving context pipe: ${pipePath} ← ${templatePath}`);
}

function startLegacyWatcher(config: PipeConfig) {
  log.info("Running in Legacy Mode — files will be modified on disk");
  log.info("git may detect changes in output files");

  const watchedFiles = config.injected
    .filter((i) => i.watch)
    .map((i) => i.file);

  const debounceMs = config.settings.debounceMs;

  const renderPipes = config.pipes.filter((p) => p.render);

  const pipesByTemplate = new Map<string, typeof renderPipes>();
  for (const pipe of renderPipes) {
    const list = pipesByTemplate.get(pipe.render!) || [];
    list.push(pipe);
    pipesByTemplate.set(pipe.render!, list);
  }

  for (const [templatePath, pipes] of pipesByTemplate) {
    if (fs.existsSync(templatePath)) {
      try {
        const changed = injectFile(templatePath, config);
        if (changed) {
          const template = fs.readFileSync(templatePath, "utf-8");
          const base = loadBase(config);
          const composed = composeContent(base, template.trim());
          for (const pipe of pipes) {
            try { fs.chmodSync(pipe.file, 0o666); } catch {}
            fs.writeFileSync(pipe.file, composed, "utf-8");
            fs.chmodSync(pipe.file, 0o444);
            log.info(`Rendered: ${templatePath} → ${pipe.file}`);
          }
        }
      } catch (err: unknown) {
        log.error(`Error rendering ${templatePath}: ${err}`);
      }
    }
  }

  const contextPipes = renderPipes.filter((p) => p.render);
  if (contextPipes.length > 0) {
    const contextFiles = contextPipes.map((p) => p.file);
    for (const cf of contextFiles) {
      if (fs.existsSync(cf)) {
        try {
          const templatePath = contextPipes.find((p) => p.file === cf)!.render!;
          const watcher = chokidar.watch(cf, {
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
              stabilityThreshold: 1000,
              pollInterval: 200,
            },
          });

          let ctxTimer: NodeJS.Timeout | null = null;
          watcher.on("change", () => {
            if (writeBackInProgress) return;
            if (ctxTimer) trackedClearTimeout(ctxTimer);
            ctxTimer = trackedSetTimeout(() => {
              ctxTimer = null;
              try {
                const data = fs.readFileSync(cf, "utf-8");
                handleIncomingWrite(data, templatePath, config);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                log.error(`Error reading context file ${cf}: ${msg}`);
              }
            }, debounceMs);
          });

          log.info(`Watching context file for AI edits: ${cf}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Could not watch context file ${cf}: ${msg}`);
        }
      }
    }
  }

  if (watchedFiles.length > 0) {
    const watcher = chokidar.watch(watchedFiles, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    const debounceTimers = new Map<string, NodeJS.Timeout>();

    watcher.on("change", (file: string) => {
      const existing = debounceTimers.get(file);
      if (existing) {
        trackedClearTimeout(existing);
        log.info(`Debounced: ${file} (waiting ${debounceMs}ms)`);
      }

      debounceTimers.set(file, trackedSetTimeout(() => {
        debounceTimers.delete(file);

        const matchedPipes = renderPipes.filter((p) => p.render === file);
        if (matchedPipes.length > 0) {
          try {
            const changed = injectFile(file, config);
            if (changed) {
              const template = fs.readFileSync(file, "utf-8");
              const base = loadBase(config);
              const composed = composeContent(base, template.trim());
              for (const pipe of matchedPipes) {
                try { fs.chmodSync(pipe.file, 0o666); } catch {}
                fs.writeFileSync(pipe.file, composed, "utf-8");
                fs.chmodSync(pipe.file, 0o444);
                log.info(`Rendered: ${file} → ${pipe.file}`);
              }
            }
          } catch (err: unknown) {
            log.error(`Error rendering ${file}: ${err}`);
          }
          return;
        }

        try {
          const changed = injectFile(file, config);
          if (changed) {
            log.info(`Injected: ${file}`);
          }
        } catch (err: unknown) {
          log.error(`Error injecting ${file}: ${err}`);
        }
      }, debounceMs));
    });

    log.info(`Watching: ${watchedFiles.join(", ")} (debounce: ${debounceMs}ms)`);
  }
}

function runPipeMode(config: PipeConfig) {
  log.info("Pipe mode: mkfifo available");

  const allPipePaths: string[] = [];
  for (const pipe of config.pipes) {
    const pipePath = resolvePipePath(pipe.file, pipe);
    const created = createPipe(pipePath);
    if (created) {
      allPipePaths.push(pipePath);
    }
  }

  for (const pipe of config.pipes) {
    const pipePath = resolvePipePath(pipe.file, pipe);
    if (!fs.existsSync(pipePath)) continue;

    if (pipe.render) {
      serveContextPipe(pipePath, pipe.render, config);
    } else if (pipe.command) {
      serveCommandPipe(pipePath, pipe.command, config);
    }
  }

  return allPipePaths;
}

function shutdown(allPipePaths: string[]) {
  shuttingDown = true;
  log.info("Daemon shutting down...");

  for (const id of activeTimers) {
    try { clearTimeout(id as any); } catch {}
    try { clearInterval(id as any); } catch {}
  }
  activeTimers.length = 0;

  for (const entry of contextStreamEntries) {
    try { entry.stream.destroy(); } catch {}
    try { fs.closeSync(entry.fd); } catch {}
  }
  contextStreamEntries.length = 0;

  for (const p of allPipePaths) {
    try { fs.unlinkSync(p); } catch {}
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}

export function runDaemon() {
  log.info("PipeMD daemon starting...");

  process.on("SIGPIPE", () => {});

  const config = loadConfig();
  resetDaemonStart();

  fs.mkdirSync(LIVE_DIR, { recursive: true });
  ensureCacheDir();

  if (config.commands && config.commands["crew"]) {
    const crewStaleMs = config.settings?.crew?.staleMs ?? DEFAULT_STALE_MS;
    trackedSetInterval(() => {
      try {
        const reaped = reapStaleSessions(crewStaleMs);
        if (reaped.length) {
          log.info(`Crew: reaped ${reaped.length} stale session(s)`);
          writeDashboard();
        }
      } catch (err) {
        log.warn(`Crew reap failed: ${err}`);
      }
    }, 30_000);

    writeDashboard();
    trackedSetInterval(writeDashboard, 5_000);
  }

  trackedSetInterval(() => {
    try { purgeOldRecords(); } catch {}
  }, 300_000);

  trackedSetInterval(() => {
    try { cleanInjectionLog(); } catch {}
  }, 300_000);

  const hasMkfifo = checkMkfifo();

  const pipeModePipes = config.pipes.filter((p) => {
    if (p.mode === "legacy") return false;
    if (p.mode === "pipe") return true;
    return hasMkfifo;
  });

  const legacyModePipes = config.pipes.filter((p) => {
    if (p.mode === "pipe") return false;
    if (p.mode === "legacy") return true;
    return !hasMkfifo;
  });

  let allPipePaths: string[] = [];

  if (legacyModePipes.length > 0) {
    const legacyConfig: PipeConfig = { ...config, pipes: legacyModePipes };
    startLegacyWatcher(legacyConfig);
  }

  if (pipeModePipes.length > 0 && hasMkfifo) {
    const pipeConfig: PipeConfig = { ...config, pipes: pipeModePipes };
    allPipePaths = runPipeMode(pipeConfig);
  } else if (legacyModePipes.length === 0) {
    startLegacyWatcher(config);
  }

  process.on("SIGTERM", () => shutdown(allPipePaths));
  process.on("SIGINT", () => shutdown(allPipePaths));
  process.on("SIGHUP", () => {});

  process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    shutdown(allPipePaths);
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.error(`Unhandled rejection: ${msg}`);
    shutdown(allPipePaths);
  });

  log.info("Daemon running.");
}

export function writePidFile(pid: number) {
  fs.writeFileSync(PID_FILE, String(pid), "utf-8");
}

export function readPidFile(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}
