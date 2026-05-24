// statusline.ts — `pmd statusline`: the dev-side status surface.
//
// Claude Code has no pluggable TUI panel (unlike OpenCode) but supports a
// command-type statusLine; Gemini CLI has neither, but hook output's
// `systemMessage` field renders straight to the developer's terminal. Both are
// wired up by `pmd crew install-hooks` and invoked automatically by the harness
// — surfacing daemon/crew/injection state to the developer with no model
// involvement. `--format claude` writes the raw line (ANSI ok); `--format gemini`
// wraps it as {"systemMessage":"..."} for a Gemini SessionStart/AfterAgent hook
// (debounced — Gemini double-fires SessionStart).
// It must stay fast: pure filesystem reads, no spawn, no network.

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import {
  PIPEMD_DIR,
  listSessions,
  findConflicts,
} from "../core/crew.js";
import { isPidAlive } from "../core/json-utils.js";
import { log } from "../core/logger.js";
import {
  DAEMON_PID_FILE,
  estimateTokens,
  formatTokenCount,
  findContextBytes,
  readInjectStats,
  readCrewSnapshot,
  shouldSuppressGeminiStatusline,
} from "../core/statusline-data.js";

/** A chalk-shaped painter — the real chalk, or identity functions for --plain. */
interface Painter {
  bold: (s: string) => string;
  dim: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
}

const identity = (s: string) => s;
const NO_COLOR: Painter = {
  bold: identity,
  dim: identity,
  green: identity,
  yellow: identity,
  red: identity,
};

/**
 * Read Claude Code's statusLine JSON payload from stdin. Skipped on a TTY so a
 * manual `pmd statusline` run (preview / smoke test) doesn't block on fd 0.
 */
function readStdinJson(): any | null {
  if (process.stdin.isTTY) return null;
  try {
    const raw = fs.readFileSync(0, "utf-8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err: unknown) {
    log.debug(`read stdin JSON: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function readDaemonPid(pipemdDir: string): number | null {
  try {
    const pid = parseInt(
      fs.readFileSync(path.join(pipemdDir, DAEMON_PID_FILE), "utf-8").trim(),
      10,
    );
    if (pid > 0 && isPidAlive(pid)) return pid;
  } catch (err: unknown) {
    log.debug(`read daemon PID: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function renderStatusline(color: boolean): string {
  const c: Painter = color ? (chalk as unknown as Painter) : NO_COLOR;
  const cwd = process.cwd();

  const running = readDaemonPid(PIPEMD_DIR) !== null;

  // One consistent crew picture. Prefer the daemon's unified snapshot so the
  // session / conflict / passive counts always agree; fall back to a live
  // (file-only) ledger read when the daemon is down.
  let sessionCount: number;
  let conflictPaths: string[];
  let passiveCount: number | null;
  const snapshot = readCrewSnapshot(PIPEMD_DIR);
  if (snapshot) {
    sessionCount = snapshot.sessionCount;
    conflictPaths = snapshot.conflictPaths;
    passiveCount = snapshot.passiveCount;
  } else {
    const sessions = listSessions();
    sessionCount = sessions.length;
    conflictPaths = findConflicts(sessions).map((cf) => cf.path);
    passiveCount = null; // passive detection needs the daemon's ps scan
  }

  const tokens = estimateTokens(findContextBytes(PIPEMD_DIR, cwd));
  const stats = readInjectStats(PIPEMD_DIR);

  const parts: string[] = [];
  parts.push(c.bold("◆ PipeMD"));
  parts.push(running ? c.green("● running") : c.dim("○ stopped"));
  if (sessionCount) parts.push(`${sessionCount} crew`);
  if (passiveCount) parts.push(c.yellow(`${passiveCount} passive`));
  if (conflictPaths.length) {
    const plural = conflictPaths.length > 1 ? "s" : "";
    parts.push(c.red(`⚠ ${conflictPaths.length} conflict${plural}`));
  }
  if (tokens > 0) parts.push(c.dim(`ctx ${formatTokenCount(tokens)}`));
  if (stats.delivered || stats.dedup) {
    parts.push(c.dim(`${stats.delivered}↑ ${stats.dedup}⊘`));
  }
  if (stats.lastEvent) {
    const e = stats.lastEvent;
    const base = e.file ? path.basename(e.file) : "";
    const mark = e.result === "delivered" ? "✓" : "⊘";
    parts.push(c.dim(`${e.trigger}${base ? " " + base : ""} ${mark}`));
  }

  let line = parts.join(c.dim(" · "));

  // Conflicts are the signal a developer must not miss — break them onto a
  // second, highlighted line with the contested file names.
  if (conflictPaths.length) {
    const detail = conflictPaths
      .slice(0, 3)
      .map((p) => path.basename(p))
      .join(", ");
    line += "\n" + c.red(`  ⚠ contested: ${detail}`);
  }

  return line;
}

const statusline = new Command("statusline")
  .description(
    "Render the PipeMD statusline (invoked by the Claude Code statusLine hook)",
  )
  .configureHelp({ visibleCommands: () => [] })
  .option("--format <format>", "output format: claude | gemini | plain", "claude")
  .option("--plain", "disable ANSI colour (preview / smoke test)")
  .action((opts: { format?: string; plain?: boolean }) => {
    const fmt = opts.format ?? "claude";
    // --plain is the manual preview / smoke-test path: never read stdin there.
    const wantStdin = !opts.plain && fmt !== "plain";
    const input = wantStdin ? readStdinJson() : null;
    const cwd =
      input?.workspace?.current_dir ?? input?.cwd ?? process.cwd();
    try {
      if (cwd && fs.existsSync(cwd)) process.chdir(cwd);
    } catch (err: unknown) {
      log.debug(`chdir to ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Harmless in non-PipeMD projects — print nothing, exit clean.
    if (!fs.existsSync(path.join(PIPEMD_DIR, "config.yml"))) return;

    // Claude renders the line directly (ANSI ok); Gemini embeds it in a JSON
    // `systemMessage` shown to the dev, not the model — keep it plain there.
    const color = !opts.plain && fmt === "claude";
    const line = renderStatusline(color);
    if (!line) return;

    if (fmt === "gemini") {
      // Gemini's SessionStart hook double-fires at startup — collapse an
      // identical line emitted moments ago so the dev sees it just once.
      if (shouldSuppressGeminiStatusline(PIPEMD_DIR, line)) return;
      process.stdout.write(JSON.stringify({ systemMessage: line }) + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  });

export const statuslineCommand = statusline;
