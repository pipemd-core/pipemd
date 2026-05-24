import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { readPidFile } from "../core/daemon.js";
import { log, tailLog, errMsg } from "../core/logger.js";
import { PIPEMD_DIR, STATUS_FILE, LIVE_DIR, INJECT_STATS_FILE } from "../core/paths.js";
import { loadConfig, ConfigError } from "../core/daemon-config.js";
import { readInjectStats } from "../core/json-utils.js";
import { formatTimeAgo } from "../core/json-utils.js";

export const statusCommand = new Command("status")
  .description("Show daemon health, injection stats, and recent logs")
  .option("-l, --log <lines>", "Show last N log lines", "10")
  .action((options: { log: string }) => {
    const pid = readPidFile();

    if (!pid) {
      console.log(chalk.yellow("⚠ No daemon running."));
      return;
    }

    let running = false;
    try {
      process.kill(pid, 0);
      running = true;
    } catch (err: unknown) { log.debug(`daemon pid check failed: ${errMsg(err)}`); }

    if (!running) {
      console.log(chalk.red(`✖ Daemon (PID ${pid}) is not running.`));
      return;
    }

    console.log(chalk.green(`✔ Daemon running (PID ${pid})`));

    if (fs.existsSync(STATUS_FILE)) {
      try {
        const status = JSON.parse(fs.readFileSync(STATUS_FILE, "utf-8"));
        console.log(chalk.dim(`  Last Render: ${status.lastRun}`));
        console.log(chalk.dim(`  Render Time: ${status.durationMs}ms`));
        if (status.error) {
          console.log(chalk.red(`  Last Error:  ${status.error}`));
        }
      } catch (e) {
        log.error("Error reading status file");
      }
    }

    try {
      const config = loadConfig();

      const injected = (config.injected || [])
        .filter((i: { watch?: boolean }) => i.watch)
        .map((i: { file: string }) => i.file);

      if (injected.length > 0) {
        console.log(chalk.dim(`  Watching: ${injected.join(", ")}`));
      }

      if (fs.existsSync(LIVE_DIR)) {
        const pipes = fs.readdirSync(LIVE_DIR);
        if (pipes.length > 0) {
          console.log(chalk.dim(`  Pipes:    ${pipes.map((p) => path.join(LIVE_DIR, p)).join(", ")}`));
        }
      }

      const renderPipes = (config.pipes || []).filter((p: { render?: string }) => p.render);
      if (renderPipes.length > 0) {
        for (const p of renderPipes) {
          console.log(chalk.dim(`  Context:  ${p.file} ← ${p.render}`));
        }
      }
    } catch (err: unknown) {
      if (err instanceof ConfigError) {
        log.error(err.message);
      }
    }

    try {
      const injectStats = readInjectStats(INJECT_STATS_FILE);
      if (injectStats.delivered > 0 || injectStats.dedup > 0) {
        const total = injectStats.delivered + injectStats.dedup;
        console.log(chalk.dim(`  Injected: ${injectStats.delivered} delivered · ${injectStats.dedup} deduped · ${total} total`));
        if (injectStats.lastEvent) {
          const ev = injectStats.lastEvent;
          const ago = formatTimeAgo(new Date(ev.ts as number).toISOString());
          console.log(chalk.dim(`  Last:     ${String(ev.trigger)} ${String(ev.file || "")} (${String(ev.result)}) ${ago}`));
        }
      }
    } catch { /* inject stats are best-effort */ }

    const logLines = parseInt(options.log, 10) || 10;
    const recentLogs = tailLog(logLines);
    if (recentLogs.trim()) {
      console.log();
      console.log(chalk.bold("Recent logs:"));
      console.log(chalk.dim(recentLogs));
    }
  });