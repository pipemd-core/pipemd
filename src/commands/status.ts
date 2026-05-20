import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import YAML from "yaml";
import { readPidFile } from "../core/daemon.js";
import { log, tailLog } from "../core/logger.js";
import { PIPEMD_DIR, STATUS_FILE, LIVE_DIR, CONFIG_PATH } from "../core/paths.js";

export const statusCommand = new Command("status")
  .description("Show daemon health and recent logs")
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
    } catch {}

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

    if (fs.existsSync(CONFIG_PATH)) {
      const config = YAML.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

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
    }

    const logLines = parseInt(options.log, 10) || 10;
    const recentLogs = tailLog(logLines);
    if (recentLogs.trim()) {
      console.log();
      console.log(chalk.bold("Recent logs:"));
      console.log(chalk.dim(recentLogs));
    }
  });