import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import YAML from "yaml";
import type { PipeConfig, PipeMode, TokenProfile } from "../../config.js";
import { installHooks } from "../../core/hooks.js";
import {
  generateInjectionYml,
  DEFAULT_ACTIVE_RULES,
} from "../../core/injection-types.js";
import type { DeliveryMode } from "../../core/injection-types.js";
import { PIPEMD_DIR, PIPES_DIR, LIVE_DIR, SCRIPTS_DIR, TEMPLATE_PATH, CONFIG_PATH } from "../../core/paths.js";
import { HARNESS_TARGETS } from "../../core/detectHarness.js";
import type { HarnessName } from "../../core/detectHarness.js";
import type { Ecosystem } from "../../core/detect.js";
import {
  loadTemplate,
  estimateTokens,
  TOKEN_PROFILES,
  SCRIPT_MAX_LINES,
  isTrimmed,
  contextFileName,
  HARNESS_DESCRIPTIONS,
  HARNESS_USAGE_TIPS,
} from "./constants.js";
import type { ScriptDef, RunResult, AiAgent, Harness } from "./constants.js";
import { loadScriptContent, getAllScripts } from "./scripts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type { ScriptDef } from "./constants.js";
export { getAllScripts, loadScriptContent } from "./scripts.js";

function mkdirp(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeIfNew(filepath: string, content: string): boolean {
  if (fs.existsSync(filepath)) {
    console.log(chalk.yellow(`  → Skipped (already exists): ${filepath}`));
    return false;
  }
  fs.writeFileSync(filepath, content, "utf-8");
  return true;
}

export function ensurePmdTags(filepath: string, tagNames: string[]): string[] {
  if (!fs.existsSync(filepath)) return [];

  const content = fs.readFileSync(filepath, "utf-8");
  const appended: string[] = [];

  const existingTags = new Set<string>();
  for (const m of content.matchAll(/<!--\s*pmd:\s*(\w+)\s*-->/g)) {
    existingTags.add(m[1]);
  }

  const missing = tagNames.filter((t) => !existingTags.has(t));
  if (missing.length === 0) {
    console.log(chalk.yellow(`  → ${filepath} already has all pmd tags`));
    return [];
  }

  let suffix = content.endsWith("\n") ? "" : "\n";
  for (const name of missing) {
    suffix += `\n<!-- pmd: ${name} -->\n\`\`\`\n\n\`\`\`\n<!-- /pmd -->\n`;
    appended.push(name);
  }

  fs.writeFileSync(filepath, content + suffix, "utf-8");
  console.log(chalk.green(`  → Appended tags to ${filepath}: ${missing.join(", ")}`));
  return appended;
}

function stripPmdBlocksFromContent(content: string): string {
  return content.replace(/<!--\s*pmd:\s*[\w-]+\s*-->[\s\S]*?<!--\s*\/pmd\s*-->\n?/g, "");
}

function appendGitignoreEntries(targetFiles: string[]): void {
  const GITIGNORE_PATH = ".gitignore";
  const entries = [
    "# PipeMD ephemeral context files",
    ...targetFiles,
    ".pipemd/live/",
    ".pipemd/.daemon.pid",
  ];

  for (const filepath of [GITIGNORE_PATH, ".ignore"]) {
    let existing = "";
    if (fs.existsSync(filepath)) {
      existing = fs.readFileSync(filepath, "utf-8");
    }

    const lines = existing.split("\n");
    const toAdd = entries.filter((e) => !lines.includes(e));

    if (toAdd.length === 0) {
      console.log(chalk.yellow(`  → ${filepath} already contains required entries.`));
      continue;
    }

    const addition = (existing && !existing.endsWith("\n") ? "\n" : "") + toAdd.join("\n") + "\n";
    fs.appendFileSync(filepath, addition, "utf-8");
    console.log(chalk.green(`  → Appended to ${filepath}: ${toAdd.filter(e => !e.startsWith("#")).join(", ")}`));
  }
}

function generateConfigYml(config: PipeConfig): string {
  const lines: string[] = [`version: "${config.version}"`, ""];

  lines.push("# ⚠️ Security Warning: PipeMD executes the commands below exactly as written.", "# Do not run PipeMD in an untrusted repository.", "");
  if (config.base) {
    lines.push("# Base instructions prepended to the served context file", `base: "${config.base}"`, "");
  }
  if (config.delivery) {
    lines.push(`delivery: "${config.delivery}"`, "");
  }
  lines.push("# Define commands that the harness can run", "commands:");
  for (const [name, cmd] of Object.entries(config.commands)) {
    lines.push(`  ${name}: "${cmd}"`);
  }

  lines.push("", "# Template file for Legacy Mode (no mkfifo)", "injected:");
  for (const inj of config.injected) {
    lines.push(`  - file: "${inj.file}"`);
    lines.push(`    watch: ${inj.watch}`);
  }

  lines.push("", "# Named pipes (mkfifo) — real-time streams", "pipes:");
  for (const pipe of config.pipes) {
    lines.push(`  - file: "${pipe.file}"`);
    if (pipe.render) {
      lines.push(`    render: "${pipe.render}"`);
    } else if (pipe.command) {
      lines.push(`    command: "${pipe.command}"`);
    }
    if (pipe.mode) {
      lines.push(`    mode: "${pipe.mode}"`);
    }
  }

  lines.push("", "# Daemon settings", "settings:");
  lines.push(`  debounceMs: ${config.settings.debounceMs}`);
  lines.push(`  reServeDelayMs: ${config.settings.reServeDelayMs}`);
  lines.push(`  tokenProfile: ${config.settings.tokenProfile || "medium"}`);
  lines.push("");
  return lines.join("\n");
}

function generateTemplate(agent: AiAgent, selectedScripts: ScriptDef[]): string {
  const sorted = [...selectedScripts].sort((a, b) => a.volatile - b.volatile);
  const stableScripts = sorted.filter((s) => s.volatile <= 2);
  const volatileScripts = sorted.filter((s) => s.volatile > 2);

  const tagBlock = (script: ScriptDef) => `<!-- pmd: ${script.id} -->\n\`\`\`\n\n\`\`\`\n<!-- /pmd -->`;

  const sections: string[] = [];

  sections.push(`# 🏴‍☠️ Context — powered by PipeMD

> **🤖 PipeMD Context File**
>
> This file is maintained by PipeMD. It refreshes automatically.
>
> - Content inside \`<!-- pmd: -->\` blocks is **read-only** — the daemon overwrites it every cycle.
> - Everything else is **yours to edit**. Edits persist via bidirectional write-back.
> - Edits above \`<!-- pmd-context -->\` route to \`.pipemd/base.md\`. Edits below it route to \`.pipemd/template.md\`.
> - For full details, read \`.pipemd/AI_SETUP_PIPEMD.md\`.

*Stable content is at the top to maximize LLM Prompt Prefix Caching. Volatile data is at the bottom so it doesn't invalidate the cache.*

---

${loadTemplate("static-rules.md")}

${loadTemplate("agent-decision-tree.md")}`);

  if (stableScripts.length > 0) {
    sections.push(``);
    sections.push(`---`);
    sections.push(``);
    sections.push(`## Project Context`);
    for (const script of stableScripts) {
      sections.push(``);
      sections.push(`### ${script.label}`);
      sections.push(``);
      sections.push(tagBlock(script));
    }
  }

  if (volatileScripts.length > 0) {
    sections.push(``);
    sections.push(`---`);
    sections.push(``);
    sections.push(`## 🚨 Volatile State`);
    sections.push(``);
    sections.push(`*This section contains rapidly changing data. It is placed at the bottom to avoid invalidating the LLM Prompt Cache for the stable content above.*`);
    for (const script of volatileScripts) {
      sections.push(``);
      sections.push(`### ${script.label}`);
      sections.push(``);
      sections.push(tagBlock(script));
    }
  }

  sections.push(``);

  return sections.join("\n");
}

function generateFileTemplate(selectedScripts: ScriptDef[]): string {
  const sorted = [...selectedScripts].sort((a, b) => a.volatile - b.volatile);
  const stableScripts = sorted.filter((s) => s.volatile <= 2);
  const volatileScripts = sorted.filter((s) => s.volatile > 2);

  const tagBlock = (script: ScriptDef) => `<!-- pmd: ${script.id} -->\n\`\`\`\n\n\`\`\`\n<!-- /pmd -->`;

  const sections: string[] = [];

  sections.push(`# Project Context`);

  sections.push(``);
  sections.push(`> Generated by PipeMD. Run \`pmd run\` to refresh.`);
  sections.push(``);

  if (stableScripts.length > 0) {
    sections.push(`## Project Info`);
    for (const script of stableScripts) {
      sections.push(``);
      sections.push(`### ${script.label}`);
      sections.push(``);
      sections.push(tagBlock(script));
    }
  }

  if (volatileScripts.length > 0) {
    sections.push(``);
    sections.push(`---`);
    sections.push(``);
    sections.push(`## Volatile State`);
    for (const script of volatileScripts) {
      sections.push(``);
      sections.push(`### ${script.label}`);
      sections.push(``);
      sections.push(tagBlock(script));
    }
  }

  sections.push(``);
  sections.push(`---`);
  sections.push(``);
  sections.push(`*Last updated by PipeMD*`);
  sections.push(``);

  return sections.join("\n");
}

function harnessTargetFile(name: HarnessName): string {
  return HARNESS_TARGETS[name];
}

function harnessNeedsLegacy(name: HarnessName): boolean {
  return name === "Cursor" || name === "OpenClaw" || name === "Hermes" || name === "OS Agent";
}

interface ScaffoldResult {
  selectedScripts: ScriptDef[];
  commands: Record<string, string>;
  createdFiles: { path: string; status: "created" | "skipped" }[];
  addFile: (filepath: string, content: string) => void;
}

export function scaffoldProject(ecosystem: Ecosystem, selectedIds: string[], profile: TokenProfile): ScaffoldResult {
  const allScripts = getAllScripts();
  const selectedScripts = allScripts.filter((s) => selectedIds.includes(s.id));

  mkdirp(PIPES_DIR);
  mkdirp(LIVE_DIR);
  mkdirp(path.join(SCRIPTS_DIR, "architecture"));
  mkdirp(path.join(SCRIPTS_DIR, "project"));
  mkdirp(path.join(SCRIPTS_DIR, "git"));
  mkdirp(path.join(SCRIPTS_DIR, "quality"));
  mkdirp(path.join(SCRIPTS_DIR, "db"));
  mkdirp(path.join(SCRIPTS_DIR, "api"));
  mkdirp(path.join(SCRIPTS_DIR, "frontend"));
  mkdirp(path.join(SCRIPTS_DIR, "devops"));
  mkdirp(path.join(SCRIPTS_DIR, "crew"));

  const ecoEnv = `PMD_ECOSYSTEM=${ecosystem.replace(/\//g, "-")}`;
  const profileEnv = `PMD_TOKEN_PROFILE=${profile}`;
  const commands: Record<string, string> = {};
  for (const script of selectedScripts) {
    commands[script.id] = `${profileEnv} ${ecoEnv} ${script.command}`;
  }

  const createdFiles: { path: string; status: "created" | "skipped" }[] = [];
  const addFile = (filepath: string, content: string) => {
    const created = writeIfNew(filepath, content);
    createdFiles.push({ path: filepath, status: created ? "created" : "skipped" });
  };

  const ecosystemKey = ecosystem;
  for (const script of selectedScripts) {
    const scriptContent = loadScriptContent(ecosystemKey, script.file);
    if (scriptContent) {
      const scriptPath = path.join(SCRIPTS_DIR, script.file);
      addFile(scriptPath, scriptContent);
      try { fs.chmodSync(scriptPath, 0o755); } catch {}
    }
  }

  const libDir = path.join(SCRIPTS_DIR, "lib");
  const libContent = loadScriptContent(ecosystemKey, "lib/limit.sh");
  if (libContent) {
    mkdirp(libDir);
    const libPath = path.join(libDir, "limit.sh");
    addFile(libPath, libContent);
    try { fs.chmodSync(libPath, 0o755); } catch {}
  }

  const archDir = path.join(SCRIPTS_DIR, "architecture");
  const normContent = loadScriptContent(ecosystemKey, "architecture/normalize.sh");
  if (normContent) {
    mkdirp(archDir);
    const normPath = path.join(archDir, "normalize.sh");
    addFile(normPath, normContent);
    try { fs.chmodSync(normPath, 0o755); } catch {}
  }

  addFile(path.join(PIPEMD_DIR, ".gitignore"), "live/\ncrew/\n.daemon.pid\ndaemon.log\n");

  const aiSetupSrc = path.join(__dirname, "..", "AI_SETUP_PIPEMD.md");
  if (fs.existsSync(aiSetupSrc)) {
    addFile(path.join(PIPEMD_DIR, "AI_SETUP_PIPEMD.md"), fs.readFileSync(aiSetupSrc, "utf-8"));
  }

  return { selectedScripts, commands, createdFiles, addFile };
}

function updateConfigInjected(configPath: string, mdFile: string, harnessPipes?: { file: string; render: string; mode?: PipeMode }[]): boolean {
  if (!fs.existsSync(configPath)) return false;

  const raw = fs.readFileSync(configPath, "utf-8");
  const config = YAML.parse(raw) as PipeConfig;

  const injected = config.injected || [];
  const hasFile = injected.some((i) => i.file === ".pipemd/template.md");

  if (!hasFile) {
    config.injected = [{ file: ".pipemd/template.md", watch: true }];
  }

  if (harnessPipes && harnessPipes.length > 0) {
    const existingRenderFiles = new Set(
      (config.pipes || [])
        .filter((p) => p.render === ".pipemd/template.md")
        .map((p) => p.file),
    );

    for (const hp of harnessPipes) {
      if (!existingRenderFiles.has(hp.file)) {
        config.pipes = [...(config.pipes || []), hp];
        existingRenderFiles.add(hp.file);
      }
    }
  } else {
    const hasContextPipe = (config.pipes || []).some(
      (p: { render?: string; file?: string }) => p.render === ".pipemd/template.md",
    );
    if (!hasContextPipe) {
      config.pipes = [
        { file: mdFile, render: ".pipemd/template.md" },
        ...(config.pipes || []),
      ];
    } else {
      config.pipes = (config.pipes || []).map(
        (p: { render?: string; file?: string; command?: string; mode?: string }) => {
          if (p.render === ".pipemd/template.md") {
            return { file: mdFile, render: ".pipemd/template.md" };
          }
          return { file: p.file!, command: p.command, render: p.render };
        },
      );
    }
  }

  fs.writeFileSync(configPath, YAML.stringify(config), "utf-8");
  console.log(chalk.green(`  → Updated config: context pipe → ${mdFile}`));
  return true;
}

export function runInit(
  agent: AiAgent,
  ecosystem: Ecosystem,
  selectedIds: string[],
  profile: TokenProfile,
  harnesses: HarnessName[] = [],
  delivery: DeliveryMode = "passive",
): void {
  const { selectedScripts, commands, createdFiles, addFile } = scaffoldProject(ecosystem, selectedIds, profile);

  const primaryFile = harnesses.length > 0
    ? harnessTargetFile(harnesses[0])
    : contextFileName(agent);

  const pipes: { file: string; command?: string; render?: string; mode?: PipeMode }[] = [];
  for (const script of selectedScripts) {
    pipes.push({ file: `${script.id}.md`, command: script.id });
  }

  if (harnesses.length > 0) {
    for (const name of harnesses) {
      const targetFile = harnessTargetFile(name);
      const mode: PipeMode = harnessNeedsLegacy(name) ? "legacy" : "pipe";
      pipes.unshift({ file: targetFile, render: ".pipemd/template.md", mode });
    }
  } else {
    pipes.unshift({ file: primaryFile, render: ".pipemd/template.md" });
  }

  let baseFile: string | undefined;

  if (fs.existsSync(primaryFile) && !fs.existsSync(TEMPLATE_PATH)) {
    const existing = fs.readFileSync(primaryFile, "utf-8");
    const baseContent = stripPmdBlocksFromContent(existing).trim();
    if (baseContent) {
      const basePath = path.join(PIPEMD_DIR, "base.md");
      fs.writeFileSync(basePath, baseContent + "\n", "utf-8");
      baseFile = ".pipemd/base.md";
      console.log(chalk.green(`  → Saved base instructions: ${basePath}`));
    }
  }

  const config: PipeConfig = {
    version: "1.0",
    ...(baseFile ? { base: baseFile } : {}),
    delivery,
    commands,
    injected: [{ file: ".pipemd/template.md", watch: true }],
    pipes,
    settings: { debounceMs: 3000, reServeDelayMs: 500, tokenProfile: profile },
  };

  const configYml = generateConfigYml(config);

  addFile(CONFIG_PATH, configYml);

  if (delivery === "expert") {
    const expertConfig = { ...DEFAULT_ACTIVE_RULES, delivery: "expert" as DeliveryMode };
    const injectionYml = generateInjectionYml(expertConfig);
    writeIfNew(path.join(PIPEMD_DIR, "injection.yml"), injectionYml);
    console.log(chalk.green("  → Created: .pipemd/injection.yml (Expert injection rules)"));
  } else if (delivery === "active") {
    const injectionYml = generateInjectionYml(DEFAULT_ACTIVE_RULES);
    writeIfNew(path.join(PIPEMD_DIR, "injection.yml"), injectionYml);
    console.log(chalk.green("  → Created: .pipemd/injection.yml (Active mode defaults)"));
  }

  if (harnesses.length > 0) {
    const harnessPipes = harnesses.map((name) => ({
      file: harnessTargetFile(name),
      render: ".pipemd/template.md",
      mode: harnessNeedsLegacy(name) ? "legacy" as PipeMode : "pipe" as PipeMode,
    }));
    updateConfigInjected(CONFIG_PATH, primaryFile, harnessPipes);
  } else {
    updateConfigInjected(CONFIG_PATH, primaryFile);
  }

  const templateContent = generateTemplate(agent, selectedScripts);
  let templateCreated: boolean;

  if (fs.existsSync(TEMPLATE_PATH)) {
    console.log(chalk.yellow(`  → Skipped (already exists): ${TEMPLATE_PATH}`));
    templateCreated = false;
    const appended = ensurePmdTags(TEMPLATE_PATH, Object.keys(config.commands));
    if (appended.length > 0) templateCreated = true;
  } else if (fs.existsSync(primaryFile)) {
    fs.writeFileSync(TEMPLATE_PATH, templateContent, "utf-8");
    const bakPath = path.join(PIPEMD_DIR, "context.bak");
    writeIfNew(bakPath, fs.readFileSync(primaryFile, "utf-8"));
    console.log(chalk.green(`  → Created: ${TEMPLATE_PATH} (base from existing ${primaryFile})`));
    templateCreated = true;
  } else {
    fs.writeFileSync(TEMPLATE_PATH, templateContent, "utf-8");
    templateCreated = true;
    console.log(chalk.green(`  → Created: ${TEMPLATE_PATH}`));
  }
  createdFiles.push({ path: TEMPLATE_PATH, status: templateCreated ? "created" : "skipped" });

  const targetFiles = harnesses.length > 0
    ? harnesses.map(h => harnessTargetFile(h))
    : [primaryFile];

  appendGitignoreEntries(targetFiles);

  console.log();
  console.log(chalk.green("✔ PipeMD initialized!"));
  console.log();

  const treeLines = [
    chalk.bold("Generated files:"),
    ...createdFiles.map((f) => {
      const icon = f.status === "created" ? chalk.green("✓") : chalk.yellow("⏭");
      return `  ${icon} ${f.path}`;
    }),
  ];

  console.log(treeLines.join("\n"));

  if (templateCreated && fs.existsSync(TEMPLATE_PATH)) {
    console.log();
    console.log(chalk.bold(`Contents of ${TEMPLATE_PATH}:`));
    console.log(chalk.dim("─".repeat(50)));
    console.log(fs.readFileSync(TEMPLATE_PATH, "utf-8"));
    console.log(chalk.dim("─".repeat(50)));
  }

  console.log();
  console.log(chalk.bold("How it works:"));
  console.log(chalk.dim("  • Edit the template:  ") + chalk.cyan(".pipemd/template.md"));
  console.log(chalk.dim(`  • Delivery mode:   `) + chalk.cyan(delivery));
  if (delivery === "active" || delivery === "expert") {
    console.log(chalk.dim(`  • Injection rules: `) + chalk.cyan(".pipemd/injection.yml"));
  }
  if (harnesses.length > 0) {
    for (const name of harnesses) {
      const target = harnessTargetFile(name);
      const mode = harnessNeedsLegacy(name) ? "Legacy file-write mode" : "Named Pipe mode";
      console.log(chalk.dim(`  • ${name} reads:      `) + chalk.cyan(target) + chalk.dim(` (${mode})`));
    }
  } else {
    console.log(chalk.dim("  • AI reads live data:  ") + chalk.cyan(primaryFile) + chalk.dim(" (named pipe, served on read)"));
  }
  console.log(chalk.dim("  • AI edits to ") + chalk.cyan(primaryFile) + chalk.dim(" are de-rendered and saved back to the template"));
  console.log(chalk.dim("  • Content inside ") + chalk.cyan("<!-- pmd: -->") + chalk.dim(" blocks is read-only — the daemon overwrites it every cycle"));
  console.log();
  console.log(chalk.bold("Next steps:"));
  console.log(chalk.dim("  1. Review    → .pipemd/config.yml"));
  console.log(chalk.dim("  2. Start     → pmd start"));
  console.log(chalk.dim("  3. Observe   → pmd status"));
  console.log(chalk.dim("  4. Stop      → pmd stop"));
  console.log();
}

export function runInitFile(
  ecosystem: Ecosystem,
  selectedIds: string[],
  profile: TokenProfile,
  outputFile: string,
): void {
  const { selectedScripts, commands, createdFiles, addFile } = scaffoldProject(ecosystem, selectedIds, profile);

  const config: PipeConfig = {
    version: "1.0",
    output: outputFile,
    commands,
    injected: [{ file: ".pipemd/template.md", watch: true }],
    pipes: [],
    settings: { debounceMs: 3000, reServeDelayMs: 500, tokenProfile: profile },
  };

  const configYml = generateConfigYml(config);

  addFile(CONFIG_PATH, configYml);

  const templateContent = generateFileTemplate(selectedScripts);
  let templateCreated: boolean;

  if (fs.existsSync(TEMPLATE_PATH)) {
    console.log(chalk.yellow(`  → Skipped (already exists): ${TEMPLATE_PATH}`));
    templateCreated = false;
    const appended = ensurePmdTags(TEMPLATE_PATH, Object.keys(config.commands));
    if (appended.length > 0) templateCreated = true;
  } else {
    fs.writeFileSync(TEMPLATE_PATH, templateContent, "utf-8");
    templateCreated = true;
    console.log(chalk.green(`  → Created: ${TEMPLATE_PATH}`));
  }
  createdFiles.push({ path: TEMPLATE_PATH, status: templateCreated ? "created" : "skipped" });

  console.log();
  console.log(chalk.green("✔ PipeMD initialized (file mode)!"));
  console.log();

  const treeLines = [
    chalk.bold("Generated files:"),
    ...createdFiles.map((f) => {
      const icon = f.status === "created" ? chalk.green("✓") : chalk.yellow("⏭");
      return `  ${icon} ${f.path}`;
    }),
  ];

  console.log(treeLines.join("\n"));

  if (templateCreated && fs.existsSync(TEMPLATE_PATH)) {
    console.log();
    console.log(chalk.bold(`Contents of ${TEMPLATE_PATH}:`));
    console.log(chalk.dim("─".repeat(50)));
    console.log(fs.readFileSync(TEMPLATE_PATH, "utf-8"));
    console.log(chalk.dim("─".repeat(50)));
  }

  console.log();
  console.log(chalk.bold("How it works:"));
  console.log(chalk.dim("  • Edit the template:   ") + chalk.cyan(".pipemd/template.md"));
  console.log(chalk.dim("  • Generate output:      ") + chalk.cyan(`pmd run`) + chalk.dim(`  → writes to ${outputFile}`));
  console.log(chalk.dim("  • Content inside ") + chalk.cyan("<!-- pmd: -->") + chalk.dim(" blocks is script output"));
  console.log();
  console.log(chalk.bold("Next steps:"));
  console.log(chalk.dim("  1. Review     → .pipemd/config.yml"));
  console.log(chalk.dim(`  2. Generate   → pmd run -o ${outputFile}`));
  console.log(chalk.dim("  3. (Optional) Add to CI, pre-commit, or cron:"));
  console.log(chalk.dim(`       pmd run -o ${outputFile} && git add ${outputFile}`));
  console.log();
}

export function installHooksForHarnesses(harnesses: HarnessName[], delivery: DeliveryMode): void {
  if (harnesses.length === 0) return;
  for (const name of harnesses) {
    try {
      const result = installHooks(name, process.cwd(), delivery);
      if (result.installed) {
        const suffix = result.injectionMode ? ` (${delivery} mode)` : "";
        console.log(chalk.green(`  ✔ ${name}: hooks installed${suffix}`));
      } else if (result.detail.includes("already installed")) {
        console.log(chalk.dim(`  • ${name}: hooks already installed`));
      } else if (result.detail.includes("no edit-event")) {
        console.log(chalk.dim(`  • ${name}: instruction-only harness`));
      } else if (result.mechanism === "error") {
        console.log(chalk.yellow(`  ⚠ ${name}: hook install failed — ${result.detail}`));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`  ⚠ ${name}: hook install error — ${msg}`));
    }
  }
}

export function printHarnessRouting(harnesses: HarnessName[]): void {
  if (harnesses.length === 0) return;
  console.log(chalk.bold("🤖 Harness Routing Configured:"));
  for (const name of harnesses) {
    const target = harnessTargetFile(name);
    const mode = harnessNeedsLegacy(name) ? "Legacy file-write mode for indexer safety" : "Named Pipe mode";
    console.log(chalk.cyan(`  • ${name}`) + chalk.dim(` -> Routing to ${target} (${mode})`));
  }
  console.log();
  console.log(chalk.bold("🚀 How to use it right now:"));
  console.log(chalk.dim("  1. Run `pmd start`"));
  for (const name of harnesses) {
    const tip = HARNESS_USAGE_TIPS[name];
    console.log(chalk.dim(`  ${harnesses.indexOf(name) + 2}. For ${name}: ${tip}`));
  }
  console.log();
  console.log(chalk.dim("  Source of truth: .pipemd/template.md (tracked in Git)"));
  console.log(chalk.dim("  Target files are auto-ignored in .gitignore (ephemeral)"));
}
