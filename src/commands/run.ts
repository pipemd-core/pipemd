import { Command } from "commander";
import fs from "node:fs";
import chalk from "chalk";
import { renderContentAsync } from "../core/injector.js";
import { PMD_CONTEXT_SEPARATOR } from "../config.js";
import { CONFIG_PATH, TEMPLATE_PATH } from "../core/paths.js";
import { loadConfig, ConfigError } from "../core/daemon-config.js";
import { log, errMsg } from "../core/logger.js";
import { UserError } from "../core/errors.js";

export const runCommand = new Command("run")
  .description("Render context once to stdout or a file (no daemon needed)")
  .option("-o, --output <file>", "Write output to file instead of stdout")
  .action(async (options: { output?: string }) => {
    if (!fs.existsSync(CONFIG_PATH)) {
      throw new UserError("PipeMD not initialized. Run `pmd init` first.");
    }

    if (!fs.existsSync(TEMPLATE_PATH)) {
      throw new UserError("Template not found at .pipemd/template.md");
    }

    let config;
    try {
      config = loadConfig();
    } catch (err) {
      if (err instanceof ConfigError) throw new UserError(err.message);
      throw err;
    }

    const template = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    const rendered = await renderContentAsync(template, config);

    let output: string;
    if (config.base) {
      try {
        const base = fs.readFileSync(config.base, "utf-8").trimEnd();
        output = base ? base + PMD_CONTEXT_SEPARATOR + rendered : rendered;
      } catch (err: unknown) {
        log.debug(`read base file ${config.base}: ${errMsg(err)}`);
        output = rendered;
      }
    } else {
      output = rendered;
    }

    const outputPath = options.output || config.output;

    if (outputPath) {
      fs.writeFileSync(outputPath, output, "utf-8");
      console.log(chalk.green(`Rendered context written to ${outputPath}`));
    } else {
      process.stdout.write(output);
    }
  });