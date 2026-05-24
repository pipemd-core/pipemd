import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import prompts from "prompts";
import YAML from "yaml";
import { stopLogic } from "../core/actions.js";
import { removeHooks } from "../core/hooks.js";
import { detectHarnesses } from "../core/detectHarness.js";
import { PIPEMD_DIR, CONFIG_PATH, BAK_PATH, BASE_PATH, TEMPLATE_PATH } from "../core/paths.js";
import { log, errMsg } from "../core/logger.js";

const GITIGNORE_PATH = ".gitignore";
const IGNORE_PATH = ".ignore";

function contextFileFromConfig(): string | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = YAML.parse(raw) as { pipes?: { file?: string; render?: string }[] };
    const renderPipe = (config.pipes || []).find((p) => p.render);
    return renderPipe?.file ?? null;
  } catch (err: unknown) {
    log.debug(`read context file from config: ${errMsg(err)}`);
    return null;
  }
}

function stripPmdBlocks(content: string): string {
  const stripped = content.replace(/<!--\s*pmd:\s*[\w-]+\s*-->[\s\S]*?<!--\s*\/pmd\s*-->\n?/g, "");
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

function removeLinesFromFile(filepath: string, linesToRemove: string[]) {
  if (!fs.existsSync(filepath)) return;
  try {
    const content = fs.readFileSync(filepath, "utf-8");
    const existingLines = content.split("\n");
    const filtered = existingLines.filter((line) => !linesToRemove.includes(line));
    if (filtered.length === 0 || (filtered.length === 1 && filtered[0] === "")) {
      fs.unlinkSync(filepath);
      console.log(chalk.dim(`  → Removed empty file: ${filepath}`));
    } else {
      const newContent = filtered.join("\n");
      if (newContent !== content) {
        fs.writeFileSync(filepath, newContent, "utf-8");
        console.log(chalk.dim(`  → Cleaned entries from ${filepath}`));
      }
    }
  } catch (err: unknown) { log.debug(`remove lines from file ${filepath}: ${errMsg(err)}`); }
}

export const uninstallCommand = new Command("uninstall")
  .description("Remove PipeMD from this project")
  .option("-f, --force", "Skip confirmation prompt")
  .option("--delete-context", "Delete the context file entirely instead of stripping pmd blocks")
  .action(async (options: { force?: boolean; deleteContext?: boolean }) => {
    if (!fs.existsSync(PIPEMD_DIR)) {
      console.log(chalk.yellow("⚠ PipeMD is not set up in this project."));
      return;
    }

    const contextFile = contextFileFromConfig();
    const hasBackup = fs.existsSync(BAK_PATH);
    const hasBase = fs.existsSync(BASE_PATH);

    if (!options.force) {
      console.log();
      console.log(chalk.bold("This will remove:"));
      console.log(chalk.red(`  ✖ ${PIPEMD_DIR}/`));
      if (contextFile && options.deleteContext && !hasBackup && !hasBase) {
        console.log(chalk.red(`  ✖ ${contextFile}`));
      } else if (contextFile && (!options.deleteContext || hasBackup || hasBase)) {
        if (hasBase) {
          console.log(chalk.green(`  ✔ ${contextFile} will be restored from base instructions`));
        } else if (hasBackup) {
          console.log(chalk.green(`  ✔ ${contextFile} will be restored from backup`));
        } else if (fs.existsSync(TEMPLATE_PATH)) {
          console.log(chalk.green(`  ✔ ${contextFile} will be restored from template (pmd blocks stripped)`));
        } else {
          console.log(chalk.green(`  ✔ ${contextFile} will be kept (pmd blocks stripped)`));
        }
      }
      console.log(chalk.dim("  .gitignore and .ignore entries will also be cleaned"));
      console.log();

      const confirm = await prompts({
        type: "confirm",
        name: "proceed",
        message: "Continue?",
        initial: false,
      });

      if (!confirm.proceed) {
        console.log(chalk.yellow("Uninstall cancelled."));
        return;
      }
    }

    console.log();

    stopLogic();
    console.log(chalk.green("  ✔ Daemon stopped"));

    if (contextFile) {
      try { fs.chmodSync(contextFile, 0o644); } catch (err: unknown) { log.debug(`chmod context file: ${errMsg(err)}`); }

      const hasBase = fs.existsSync(BASE_PATH);
      const hasTemplate = fs.existsSync(TEMPLATE_PATH);

      if (hasBase) {
        const base = fs.readFileSync(BASE_PATH, "utf-8");
        fs.writeFileSync(contextFile, base.trim() + "\n", "utf-8");
        console.log(chalk.green(`  ✔ Restored ${contextFile} from base instructions`));
      } else if (hasBackup) {
        const backup = fs.readFileSync(BAK_PATH, "utf-8");
        fs.writeFileSync(contextFile, backup, "utf-8");
        console.log(chalk.green(`  ✔ Restored ${contextFile} from backup`));
      } else if (hasTemplate && !options.deleteContext) {
        const template = fs.readFileSync(TEMPLATE_PATH, "utf-8");
        const cleaned = stripPmdBlocks(template);
        if (cleaned.trim()) {
          fs.writeFileSync(contextFile, cleaned + "\n", "utf-8");
          console.log(chalk.green(`  ✔ Restored ${contextFile} from template (pmd blocks stripped)`));
        } else {
          fs.unlinkSync(contextFile);
          console.log(chalk.dim(`  → Removed ${contextFile} (no content outside pmd blocks)`));
        }
      } else if (!options.deleteContext && fs.existsSync(contextFile)) {
        const content = fs.readFileSync(contextFile, "utf-8");
        const cleaned = stripPmdBlocks(content);
        if (cleaned.trim()) {
          fs.writeFileSync(contextFile, cleaned + "\n", "utf-8");
          console.log(chalk.green(`  ✔ Restored ${contextFile} (pmd blocks stripped)`));
        } else {
          fs.unlinkSync(contextFile);
          console.log(chalk.dim(`  → Removed ${contextFile} (no content outside pmd blocks)`));
        }
      } else {
        if (fs.existsSync(contextFile)) {
          try {
            fs.unlinkSync(contextFile);
            console.log(chalk.green(`  ✔ Removed ${contextFile}`));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.red(`  ✖ Could not remove ${contextFile}: ${msg}`));
          }
        }
      }
    }

    try {
      const detected = detectHarnesses().filter((h) => h.detected);
      for (const h of detected) {
        const r = removeHooks(h.name);
        if (r.installed) console.log(chalk.dim(`  → Removed ${h.name} crew hooks`));
      }
    } catch (err: unknown) { log.debug(`remove harness hooks: ${errMsg(err)}`); }

    const extraArtifacts = [
      path.join(PIPEMD_DIR, ".crew-status.json"),
      path.join(PIPEMD_DIR, ".status.json"),
      path.join(PIPEMD_DIR, ".tui-stats.json"),
    ];
    for (const f of extraArtifacts) {
      try { fs.unlinkSync(f); } catch (err: unknown) { log.debug(`unlink artifact ${f}: ${errMsg(err)}`); }
    }

    try {
      fs.rmSync(PIPEMD_DIR, { recursive: true, force: true });
      console.log(chalk.green(`  ✔ Removed ${PIPEMD_DIR}/`));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`  ✖ Could not remove ${PIPEMD_DIR}: ${msg}`));
    }

    const gitignoreEntries = [contextFile, ".pipemd/live/", ".pipemd/crew/", ".pipemd/.daemon.pid"].filter(Boolean) as string[];
    removeLinesFromFile(GITIGNORE_PATH, gitignoreEntries);

    const ignoreEntries = [contextFile].filter(Boolean) as string[];
    removeLinesFromFile(IGNORE_PATH, ignoreEntries);

    console.log();
    console.log(chalk.green("✔ PipeMD has been uninstalled."));
    console.log(chalk.dim("  Run `pmd init` to set up again."));
  });