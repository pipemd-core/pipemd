import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { readPidFile, writePidFile } from "./daemon.js";
import { LIVE_DIR, CONFIG_PATH, PID_FILE } from "./paths.js";
import { UserError } from "./errors.js";

function isDaemonRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopLogic(): void {
  const pid = readPidFile();
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        throw new UserError(`Cannot stop daemon (PID ${pid}) — permission denied. The daemon may be running as a different user.`);
      }
      // ESRCH = process doesn't exist — expected for stale PID, continue to cleanup
    }
  }
  cleanStaleState();
}

function cleanStaleState() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch { /* best effort — may be locked by another start */ }

  // Cleanup pipes from config (best effort — config may be malformed)
  try {
    const rawConfig = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = YAML.parse(rawConfig) as { pipes?: { file?: string }[] };
    for (const pipe of config.pipes || []) {
      if (pipe.file && fs.existsSync(pipe.file)) {
        try { fs.unlinkSync(pipe.file); } catch { /* in use */ }
      }
    }
  } catch { /* malformed config — LIVE_DIR cleanup below catches most pipes */ }

  if (fs.existsSync(LIVE_DIR)) {
    const entries = fs.readdirSync(LIVE_DIR);
    for (const entry of entries) {
      try { fs.unlinkSync(path.join(LIVE_DIR, entry)); } catch { /* in use */ }
    }
  }
}

export function startLogic(): number {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new UserError("PipeMD not initialized. Run `pmd init` first.");
  }

  const existingPid = readPidFile();
  if (existingPid && isDaemonRunning(existingPid)) {
    throw new UserError(`Daemon already running (PID ${existingPid}).`);
  }

  cleanStaleState();

  const selfPath = process.argv[1];
  const child = spawn(process.execPath, [selfPath, "_daemon"], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  if (!child.pid) {
    throw new UserError("Failed to spawn daemon process — system may be out of resources (EMFILE or similar).");
  }

  // H2 — Atomic PID file creation: use O_EXCL to prevent the two-daemon
  // start race. If another start is in progress and created the PID file
  // between our cleanStaleState and here, EEXIST tells us we lost the race.
  try {
    const fd = fs.openSync(PID_FILE, "wx");
    fs.writeFileSync(fd, String(child.pid));
    fs.closeSync(fd);
    try { fs.chmodSync(PID_FILE, 0o600); } catch { /* best effort */ }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      try { process.kill(child.pid, "SIGTERM"); } catch { /* lost the race */ }
      throw new UserError("Another daemon start is in progress. Wait a moment and retry.");
    }
    // Non-EEXIST error — fall back to the simple write
    writePidFile(child.pid);
  }
  return child.pid;
}
