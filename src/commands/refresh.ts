import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import prompts from "prompts";
import YAML from "yaml";
import { Command } from "commander";
import { detectProject } from "../core/detect.js";
import type { Ecosystem } from "../core/detect.js";
import type { PipeConfig, TokenProfile } from "../config.js";
import {
  type ScriptDef,
  getAllScripts,
  loadScriptContent,
  ensurePmdTags,
} from "./init.js";
import { PIPEMD_DIR, CONFIG_PATH, SCRIPTS_DIR, TEMPLATE_PATH } from "../core/paths.js";
import { log, errMsg } from "../core/logger.js";
import { UserError } from "../core/errors.js";
import { loadConfig, ConfigError } from "../core/daemon-config.js";
import {
  type InjectionTrigger,
  DEFAULT_ACTIVE_RULES,
  loadInjectionConfig,
  generateInjectionYml,
} from "../core/injection-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type ScriptChange =
  | { id: string; label: string; kind: "current" }
  | { id: string; label: string; kind: "changed"; localPath: string; bundledContent: string }
  | { id: string; label: string; kind: "new"; localPath: string; bundledContent: string }
  | { id: string; label: string; kind: "missing"; localPath: string; bundledContent: string }
  | { id: string; label: string; kind: "custom" };

function detectEcosystemFromConfig(config: PipeConfig): Ecosystem | null {
  for (const cmd of Object.values(config.commands)) {
    const match = cmd.match(/PMD_ECOSYSTEM=(\S+)/);
    if (match) {
      const reverseMap: Record<string, Ecosystem> = {
        "Node-TypeScript": "Node/TypeScript",
        Python: "Python",
        "C-CPP": "C-CPP",
        Rust: "Rust",
        Go: "Go",
        DevOps: "DevOps",
        Generic: "Generic",
      };
      return reverseMap[match[1]] || null;
    }
  }
  return null;
}

function detectProfileFromConfig(config: PipeConfig): TokenProfile {
  for (const cmd of Object.values(config.commands)) {
    const match = cmd.match(/PMD_TOKEN_PROFILE=(\S+)/);
    if (match && ["low", "medium", "high", "xhigh", "unlimited"].includes(match[1])) {
      return match[1] as TokenProfile;
    }
  }
  return config.settings.tokenProfile || "medium";
}

function updateHelpers(ecosystem: Ecosystem): number {
  let updated = 0;
  for (const helper of ["lib/limit.sh", "lib/limit-core.sh", "lib/lint-compact.sh", "architecture/normalize.sh"]) {
    const bundled = loadScriptContent(ecosystem, helper);
    if (!bundled) continue;
    const localPath = path.join(SCRIPTS_DIR, helper);
    let local: string | null = null;
    try {
      local = fs.readFileSync(localPath, "utf-8");
    } catch (err: unknown) { log.debug(`read helper script: ${errMsg(err)}`); }
    if (!local || local.trim() !== bundled.trim()) {
      copyScript(localPath, bundled);
      updated++;
    }
  }
  return updated;
}

function analyzeScripts(config: PipeConfig, ecosystem: Ecosystem): ScriptChange[] {
  const allScripts = getAllScripts();
  const scriptMap = new Map(allScripts.map((s) => [s.id, s]));
  const activeIds = new Set(Object.keys(config.commands));
  const results: ScriptChange[] = [];

  for (const id of Object.keys(config.commands)) {
    const def = scriptMap.get(id);
    if (!def) {
      results.push({ id, label: id, kind: "custom" });
      continue;
    }

    const localPath = path.join(SCRIPTS_DIR, def.file);
    const bundledContent = loadScriptContent(ecosystem, def.file);

    let localContent: string | null = null;
    try {
      localContent = fs.readFileSync(localPath, "utf-8");
    } catch (err: unknown) { log.debug(`read local script: ${errMsg(err)}`); }

    if (!localContent && bundledContent) {
      results.push({ id, label: def.label, kind: "missing", localPath, bundledContent });
    } else if (!bundledContent) {
      results.push({ id, label: def.label, kind: "custom" });
    } else if (localContent!.trim() === bundledContent.trim()) {
      results.push({ id, label: def.label, kind: "current" });
    } else {
      results.push({ id, label: def.label, kind: "changed", localPath, bundledContent });
    }
  }

  for (const script of allScripts) {
    if (activeIds.has(script.id)) continue;
    const bundledContent = loadScriptContent(ecosystem, script.file);
    if (!bundledContent) continue;
    results.push({
      id: script.id,
      label: script.label,
      kind: "new",
      localPath: path.join(SCRIPTS_DIR, script.file),
      bundledContent,
    });
  }

  return results;
}

function copyScript(localPath: string, content: string): void {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, content, "utf-8");
  try {
    fs.chmodSync(localPath, 0o755);
  } catch (err: unknown) { log.debug(`chmod script ${localPath}: ${errMsg(err)}`); }
}

function buildCommand(script: ScriptDef, ecosystem: Ecosystem, profile: TokenProfile): string {
  const ecoEnv = `PMD_ECOSYSTEM=${ecosystem.replace(/\//g, "-")}`;
  const profileEnv = `PMD_TOKEN_PROFILE=${profile}`;
  return `${profileEnv} ${ecoEnv} ${script.command}`;
}

function mergeInjectionConfig(): string[] {
  const injectionPath = path.join(PIPEMD_DIR, "injection.yml");
  if (!fs.existsSync(injectionPath)) return [];

  const existing = loadInjectionConfig();
  if (existing.delivery === "passive") return [];

  const defaults = DEFAULT_ACTIVE_RULES;
  const addedSources: string[] = [];

  for (const trigger of Object.keys(defaults.rules) as InjectionTrigger[]) {
    const defaultRules = defaults.rules[trigger];
    if (!defaultRules) continue;

    const existingRules = existing.rules[trigger] || [];
    const existingSources = new Set(existingRules.map((r) => r.source));

    const missing = defaultRules.filter((r) => !existingSources.has(r.source));
    if (missing.length > 0) {
      existing.rules[trigger] = [...existingRules, ...missing];
      addedSources.push(...missing.map((r) => `${trigger}: ${r.source}`));
    }
  }

  if (addedSources.length === 0) return [];

  const updated = generateInjectionYml(existing);
  fs.writeFileSync(injectionPath, updated, "utf-8");

  return addedSources;
}

export const refreshCommand = new Command("refresh")
  .description("Update scripts to latest bundled versions")
  .option("-y, --yes", "Non-interactive: update all changed, add recommended new scripts")
  .option("--scripts <ids>", "Comma-separated script IDs to add/update (skips interactive selection)")
  .action(async (options: { yes?: boolean; scripts?: string }) => {
    if (!fs.existsSync(CONFIG_PATH)) {
      throw new UserError(chalk.red("Error: .pipemd/config.yml not found. Run `pmd init` first."));
    }

    let config: PipeConfig;
    try {
      config = loadConfig();
    } catch (err: unknown) {
      if (err instanceof ConfigError) {
        throw new UserError(chalk.red(`Error: ${err.message}`));
      }
      throw err;
    }
    const ecosystem = detectEcosystemFromConfig(config) || detectProject().ecosystem;
    const profile = detectProfileFromConfig(config);
    const detection = detectProject();

    console.log();
    console.log(chalk.cyan("🏴‍☠️ PipeMD Refresh"));
    console.log(chalk.dim(`  Ecosystem: ${ecosystem}`));
    console.log(chalk.dim(`  Profile:   ${profile}`));
    console.log(chalk.dim(`  Scripts:   ${Object.keys(config.commands).length} active`));
    console.log();

    const changes = analyzeScripts(config, ecosystem);

    const current = changes.filter((c): c is ScriptChange & { kind: "current" } => c.kind === "current");
    const changed = changes.filter((c): c is ScriptChange & { kind: "changed" } => c.kind === "changed");
    const missing = changes.filter((c): c is ScriptChange & { kind: "missing" } => c.kind === "missing");
    const newAvailable = changes.filter((c): c is ScriptChange & { kind: "new" } => c.kind === "new");
    const custom = changes.filter((c): c is ScriptChange & { kind: "custom" } => c.kind === "custom");

    if (changed.length === 0 && missing.length === 0 && newAvailable.length === 0) {
      let anyUpdates = false;
      const helperUpdates = updateHelpers(ecosystem);
      if (helperUpdates > 0) {
        console.log(chalk.dim(`  → Updated ${helperUpdates} helper script(s)`));
        anyUpdates = true;
      }
      const addedInjectionSources = mergeInjectionConfig();
      if (addedInjectionSources.length > 0) {
        console.log(chalk.bold("  Injection Rules:"));
        console.log();
        for (const src of addedInjectionSources) {
          console.log(chalk.cyan(`  + ${src}`));
        }
        console.log(chalk.green("  → Updated injection.yml"));
        anyUpdates = true;
      }
      if (anyUpdates) {
        console.log();
        console.log(chalk.green("✔ Refresh complete: helpers and injection rules updated."));
        console.log();
        console.log(chalk.dim("  Run `pmd restart` to apply changes to a running daemon."));
      } else {
        console.log(chalk.green("✔ All scripts are up to date."));
      }
      console.log();
      return;
    }

    console.log(chalk.bold("  Script Analysis:"));
    console.log();
    for (const c of current) {
      console.log(chalk.green(`  ✓ ${c.label}`) + chalk.dim(" — up to date"));
    }
    for (const c of changed) {
      console.log(chalk.yellow(`  ~ ${c.label}`) + chalk.dim(" — changed (local differs from latest)"));
    }
    for (const c of missing) {
      console.log(chalk.red(`  ! ${c.label}`) + chalk.dim(" — missing (will restore)"));
    }
    for (const c of newAvailable) {
      console.log(chalk.cyan(`  + ${c.label}`) + chalk.dim(" — new, not yet added"));
    }
    for (const c of custom) {
      console.log(chalk.dim(`  · ${c.label} — custom (skipped)`));
    }
    console.log();

    const allScripts = getAllScripts();
    const scriptMap = new Map(allScripts.map((s) => [s.id, s]));

    let toUpdate: typeof changed = [];
    let toAdd: typeof newAvailable = [];

    if (options.yes) {
      toUpdate = changed;
      toAdd = newAvailable.filter((s) => detection.recommendedScripts.includes(s.id));
    } else if (options.scripts) {
      const ids = new Set(
        options.scripts.split(",").map((s) => s.trim()).filter(Boolean),
      );
      toUpdate = changed.filter((s) => ids.has(s.id));
      toAdd = newAvailable.filter((s) => ids.has(s.id));
    } else {
      if (changed.length > 0) {
        const answer = await prompts({
          type: "multiselect",
          name: "update",
          message: "Changed scripts — select which to update to latest version:",
          choices: changed.map((s) => ({ title: s.label, value: s.id })),
          hint: "space to toggle. enter to confirm. None selected = keep your versions.",
        });
        if (answer.update) {
          toUpdate = changed.filter((s) => (answer.update as string[]).includes(s.id));
        }
      }

      if (newAvailable.length > 0) {
        const recommended = new Set(detection.recommendedScripts);
        const answer = await prompts({
          type: "multiselect",
          name: "add",
          message: "New scripts — select which to add:",
          choices: newAvailable.map((s) => ({
            title: `${s.label}${recommended.has(s.id) ? " ★" : ""}`,
            value: s.id,
          })),
          initial: newAvailable
            .map((s, i) => (recommended.has(s.id) ? i : -1))
            .filter((i) => i >= 0) as unknown as number,
          hint: "space to toggle. enter to confirm. ★ = recommended.",
        });
        if (answer.add) {
          toAdd = newAvailable.filter((s) => (answer.add as string[]).includes(s.id));
        }
      }
    }

    const allToUpdate = [...toUpdate, ...missing];

    const helperUpdates = updateHelpers(ecosystem);

    if (allToUpdate.length === 0 && toAdd.length === 0) {
      if (helperUpdates > 0) {
        console.log(chalk.dim(`  → Updated ${helperUpdates} helper script(s)`));
      } else {
        console.log(chalk.dim("Nothing to update."));
      }
      console.log();
      return;
    }

    for (const s of allToUpdate) {
      copyScript(s.localPath, s.bundledContent);
      console.log(
        chalk.green(`  ✓ ${s.kind === "missing" ? "Restored" : "Updated"}: ${s.label}`),
      );
    }

    for (const s of toAdd) {
      const def = scriptMap.get(s.id);
      if (!def) continue;

      copyScript(s.localPath, s.bundledContent);
      config.commands[def.id] = buildCommand(def, ecosystem, profile);

      const hasPipe = (config.pipes || []).some((p) => p.file === `${def.id}.md`);
      if (!hasPipe) {
        config.pipes = [
          ...(config.pipes || []),
          { file: `${def.id}.md`, command: def.id },
        ];
      }

      console.log(chalk.cyan(`  + Added: ${s.label}`));
    }

    if (helperUpdates > 0) {
      console.log(chalk.dim(`  → Updated ${helperUpdates} helper script(s)`));
    }

    const aiSetupSrc = path.join(__dirname, "..", "AI_SETUP_PIPEMD.md");
    const aiSetupDest = path.join(PIPEMD_DIR, "AI_SETUP_PIPEMD.md");
    if (fs.existsSync(aiSetupSrc)) {
      const bundled = fs.readFileSync(aiSetupSrc, "utf-8");
      let local: string | null = null;
      try {
        local = fs.readFileSync(aiSetupDest, "utf-8");
      } catch (err: unknown) { log.debug(`read AI setup doc: ${errMsg(err)}`); }
      if (!local || local.trim() !== bundled.trim()) {
        fs.writeFileSync(aiSetupDest, bundled, "utf-8");
        console.log(chalk.dim("  → Updated .pipemd/AI_SETUP_PIPEMD.md"));
      }
    }

    const addedInjectionSources = mergeInjectionConfig();
    if (addedInjectionSources.length > 0) {
      for (const src of addedInjectionSources) {
        console.log(chalk.cyan(`  + Injection rule: ${src}`));
      }
      console.log(chalk.green("  → Updated injection.yml"));
    }

    for (const s of allToUpdate) {
      const def = scriptMap.get(s.id);
      if (def) {
        config.commands[def.id] = buildCommand(def, ecosystem, profile);
      }
    }

    if (toAdd.length > 0) {
      const appended = ensurePmdTags(TEMPLATE_PATH, toAdd.map((s) => s.id));
      if (appended.length > 0) {
        console.log(
          chalk.green(`  → Added tags to template: ${appended.join(", ")}`),
        );
      }
    }

    fs.writeFileSync(CONFIG_PATH, YAML.stringify(config), "utf-8");
    console.log(chalk.green("  → Updated config.yml"));

    const updatedCount = allToUpdate.length;
    const addedCount = toAdd.length;

    console.log();
    console.log(
      chalk.green(`✔ Refresh complete: ${updatedCount} updated, ${addedCount} added.`),
    );

    if (addedCount > 0 || updatedCount > 0) {
      console.log();
      console.log(chalk.dim("  Run `pmd restart` to apply changes to a running daemon."));
    }

    console.log();
  });
