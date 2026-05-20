import { Command } from "commander";
import chalk from "chalk";
import { stopLogic } from "../core/actions.js";
import { readPidFile } from "../core/daemon.js";

export const stopCommand = new Command("stop")
  .description("Stop the background daemon")
  .action(() => {
    const pid = readPidFile();
    if (!pid) {
      console.log(chalk.yellow("⚠ No daemon PID file found."));
    } else {
      console.log(chalk.green(`✔ Sent SIGTERM to daemon (PID ${pid})`));
    }
    stopLogic();
  });
