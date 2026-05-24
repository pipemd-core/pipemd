import { Command } from "commander";
import chalk from "chalk";
import { stopLogic, startLogic } from "../core/actions.js";
import { UserError } from "../core/errors.js";

export const restartCommand = new Command("restart")
  .description("Stop then start the daemon")
  .action(() => {
    console.log(chalk.dim("  → Restarting PipeMD daemon..."));
    stopLogic();
    try {
      const pid = startLogic();
      console.log(chalk.green(`✔ PipeMD daemon restarted (PID ${pid})`));
    } catch (err: unknown) {
      throw new UserError(chalk.red(`✖ Failed to restart: ${err instanceof Error ? err.message : String(err)}`));
    }
  });
