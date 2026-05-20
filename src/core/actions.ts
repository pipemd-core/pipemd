import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
import type { PipeConfig } from "../config.js";
import { readPidFile, writePidFile } from "./daemon.js";
import { PIPEMD_DIR, LIVE_DIR, CONFIG_PATH, PID_FILE } from "./paths.js";

export function isDaemonRunning(pid: number): boolean {
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
    } catch {}
  }
  cleanStaleState();
}

export function cleanStaleState() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {}

  // Cleanup pipes
  try {
    const rawConfig = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = YAML.parse(rawConfig) as { pipes?: { file?: string }[] };
    for (const pipe of config.pipes || []) {
      if (pipe.file && fs.existsSync(pipe.file)) {
        fs.unlinkSync(pipe.file);
      }
    }
  } catch {}

  if (fs.existsSync(LIVE_DIR)) {
    const entries = fs.readdirSync(LIVE_DIR);
    for (const entry of entries) {
      try { fs.unlinkSync(path.join(LIVE_DIR, entry)); } catch {}
    }
  }
}

export function startLogic(): number {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error("PipeMD not initialized. Run `pmd init` first.");
  }

  const existingPid = readPidFile();
  if (existingPid && isDaemonRunning(existingPid)) {
    throw new Error(`Daemon already running (PID ${existingPid}).`);
  }

  cleanStaleState();

  const selfPath = process.argv[1];
  const child = spawn(process.execPath, [selfPath, "_daemon"], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  writePidFile(child.pid!);
  return child.pid!;
}
