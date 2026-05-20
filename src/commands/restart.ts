import { Command } from "commander";
import chalk from "chalk";
import { stopLogic, startLogic } from "../core/actions.js";

export const restartCommand = new Command("restart")
  .description("Stop then start the daemon")
  .action(() => {
    console.log(chalk.dim("  → Restarting PipeMD daemon..."));
    stopLogic();
    try {
      const pid = startLogic();
      console.log(chalk.green(`✔ PipeMD daemon restarted (PID ${pid})`));
    } catch (err: any) {
      console.error(chalk.red(`✖ Failed to restart: ${err.message}`));
      process.exit(1);
    }
  });
