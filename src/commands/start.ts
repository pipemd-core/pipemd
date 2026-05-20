import { Command } from "commander";
import chalk from "chalk";
import { startLogic } from "../core/actions.js";

export const startCommand = new Command("start")
  .description("Start the background daemon")
  .action(() => {
    try {
      const pid = startLogic();
      console.log(chalk.green(`✔ PipeMD daemon started (PID ${pid})`));
      console.log(chalk.dim("  Run `pmd status` to check daemon health."));
    } catch (err: any) {
      console.error(chalk.red(`✖ ${err.message}`));
      process.exit(1);
    }
  });
