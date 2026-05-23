import fs from "node:fs";
import path from "node:path";
import { PIPEMD_DIR } from "./paths.js";

const LOG_PATH = path.join(PIPEMD_DIR, "daemon.log");

function timestamp(): string {
  return new Date().toISOString();
}

function write(level: string, msg: string) {
  const line = `${timestamp()} ${level} ${msg}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    process.stderr.write(`[pmd-log-fallback] ${line}`);
  }
}

const DEBUG = typeof process.env.PMD_DEBUG !== "undefined";

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