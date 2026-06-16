import fs from "node:fs";
import path from "node:path";
import { PIPEMD_DIR } from "./paths.js";

const LOG_PATH = path.join(PIPEMD_DIR, "daemon.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024;

function rotateLogIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > LOG_MAX_BYTES) {
      const backup = LOG_PATH + ".1";
      try { fs.unlinkSync(backup); } catch {}
      fs.renameSync(LOG_PATH, backup);
    }
  } catch {
    // File doesn't exist yet — nothing to rotate
  }
}

let _lastRotateCheck = 0;

function timestamp(): string {
  return new Date().toISOString();
}

function write(level: string, msg: string) {
  const line = `${timestamp()} ${level} ${msg}\n`;
  try {
    const now = Date.now();
    if (now - _lastRotateCheck > 60_000) {
      _lastRotateCheck = now;
      rotateLogIfNeeded();
    }
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    process.stderr.write(`[pmd-log-fallback] ${line}`);
  }
}

const DEBUG = typeof process.env.PMD_DEBUG !== "undefined";

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const log = {
  debug: (msg: string) => { if (DEBUG) write("DEBUG", msg); },
  info: (msg: string) => write("INFO ", msg),
  warn: (msg: string) => write("WARN ", msg),
  error: (msg: string) => write("ERROR", msg),
};

export function tailLog(lines: number = 20): string {
  try {
    const content = fs.readFileSync(LOG_PATH, "utf-8");
    const allLines = content.trim().split("\n");
    return allLines.slice(-lines).join("\n");
  } catch {
    return "(no log file found)";
  }
}