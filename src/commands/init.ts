import { Command } from "commander";
import chalk from "chalk";
import prompts from "prompts";
import { detectProject } from "../core/detect.js";
import type { Ecosystem } from "../core/detect.js";
import { detectHarnesses, HARNESS_TARGETS, ALL_HARNESSES } from "../core/detectHarness.js";
import type { HarnessName } from "../core/detectHarness.js";
import type { PmdMode, TokenProfile } from "../config.js";
import type { DeliveryMode } from "../core/injection-types.js";
import {
  VALID_AGENTS,
  VALID_ECOSYSTEMS,
  VALID_PROFILES,
  VALID_HARNESSES,
  TOKEN_PROFILES,
  HARNESS_DESCRIPTIONS,
  HARNESS_USAGE_TIPS,
  estimateTokens,
  SCRIPT_MAX_LINES,
} from "./init/constants.js";
import type { AiAgent, Harness } from "./init/constants.js";
import { getAllScripts, testRunScripts, aiValidateScripts } from "./init/scripts.js";
import { runInit, runInitFile, installHooksForHarnesses, printHarnessRouting, ensurePmdTags } from "./init/scaffold.js";
import { renderPromptBlueprint, runHarness } from "./init/ui.js";

export type { ScriptDef } from "./init/constants.js";
export { getAllScripts, loadScriptContent, ensurePmdTags } from "./init/scaffold.js";

type InitOptions = {
  yes?: boolean;
  mode?: string;
  agent?: string;
  ecosystem?: string;
  scripts?: string;
  profile?: string;
  harness?: string;
  harnesses?: string;
  output?: string;
  headless?: boolean;
  delivery?: string;
};

function parseHarnesses(input: string): HarnessName[] {
  const mapping: Record<string, HarnessName> = {
    "OpenCode": "OpenCode",
    "opencode": "OpenCode",
    "ClaudeCode": "Claude Code",
    "claudecode": "Claude Code",
    "claude": "Claude Code",
    "Claude Code": "Claude Code",
    "Cursor": "Cursor",
    "cursor": "Cursor",
    "Aider": "Aider",
    "aider": "Aider",
    "Gemini": "Gemini",
    "gemini": "Gemini",
    "OpenClaw": "OpenClaw",
    "openclaw": "OpenClaw",
    "Hermes": "Hermes",
    "hermes": "Hermes",
    "OSAgent": "OS Agent",
    "osagent": "OS Agent",
    "os-agent": "OS Agent",
    "OS Agent": "OS Agent",
  };
  return input.split(",").map(s => s.trim()).filter(Boolean).map(s => mapping[s]).filter(Boolean);
}

function resolveEcosystem(opt: string | undefined, detected: Ecosystem): Ecosystem {
  return (VALID_ECOSYSTEMS.includes(opt as Ecosystem) ? opt : detected) as Ecosystem;
}

function resolveProfile(opt: string | undefined): TokenProfile {
  return (VALID_PROFILES.includes(opt as TokenProfile) ? opt : "medium") as TokenProfile;
}

function resolveDelivery(opt: string | undefined): DeliveryMode {
  const valid: DeliveryMode[] = ["passive", "active", "expert"];
  return valid.includes(opt as DeliveryMode) ? (opt as DeliveryMode) : "active";
}

function resolveScriptIds(scriptsOpt: string | undefined, recommended: string[]): string[] {
  const allIds = getAllScripts().map((s) => s.id);
  let ids = scriptsOpt
    ? scriptsOpt.split(",").map((s) => s.trim()).filter(Boolean)
    : recommended;
  ids = ids.filter((id) => allIds.includes(id));
  return ids.length > 0 ? ids : recommended;
}

function resolveAgent(harnesses: HarnessName[]): AiAgent {
  return harnesses.includes("Claude Code") ? "Claude Code"
    : harnesses.includes("Gemini") ? "Gemini"
    : harnesses.includes("Cursor") ? "Cursor"
    : harnesses.includes("Aider") ? "Aider"
    : harnesses.includes("OpenClaw") ? "OpenClaw"
    : harnesses.includes("Hermes") ? "Hermes"
    : "Generic";
}

function resolveHarnessList(harnessesOpt: string | undefined, detected: HarnessName[], fallback: HarnessName[] = []): HarnessName[] {
  if (harnessesOpt) return parseHarnesses(harnessesOpt);
  if (detected.length > 0) return detected;
  return fallback;
}

function warnConflictingTargets(harnesses: HarnessName[]): void {
  if (harnesses.includes("OpenClaw") && harnesses.includes("Hermes")) {
    console.log(chalk.yellow(
      "  ⚠ OpenClaw and Hermes both target WORKSPACE_CONTEXT.md. " +
      "Only one pipe will serve the file — the last one registered wins."
    ));
  }
}

function buildHeadlessSummary(
  pmdMode: PmdMode,
  ecosystem: Ecosystem,
  profile: TokenProfile,
  scripts: string[],
  harnesses?: HarnessName[],
  delivery?: DeliveryMode,
  outputFile?: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    status: "ok",
    mode: pmdMode,
    ecosystem,
    profile,
    scripts,
    templateFile: ".pipemd/template.md",
    configFile: ".pipemd/config.yml",
  };
  if (pmdMode === "agent") {
    base.delivery = delivery;
    base.harnesses = harnesses;
    base.targetFiles = harnesses?.map(h => HARNESS_TARGETS[h]);
  } else {
    base.outputFile = outputFile;
  }
  return base;
}

async function runHeadless(options: InitOptions, detection: { ecosystem: Ecosystem; signals: string[]; recommendedScripts: string[] }, detectedHarnessNames: HarnessName[]) {
  const pmdMode: PmdMode = options.mode === "file" ? "file" : "agent";
  const ecosystem = resolveEcosystem(options.ecosystem, detection.ecosystem);
  const profile = resolveProfile(options.profile);
  const selectedIds = resolveScriptIds(options.scripts, detection.recommendedScripts);

  if (pmdMode === "file") {
    const outputFile = options.output || "pmd.md";
    runInitFile(ecosystem, selectedIds, profile, outputFile);
    console.log("PIPEDM_HEADLESS_RESULT=" + JSON.stringify(buildHeadlessSummary(pmdMode, ecosystem, profile, selectedIds, undefined, undefined, outputFile)));
    return;
  }

  const harnesses = resolveHarnessList(options.harnesses, detectedHarnessNames, ["OS Agent"]);
  warnConflictingTargets(harnesses);
  const agent = resolveAgent(harnesses);
  const delivery = resolveDelivery(options.delivery);

  runInit(agent, ecosystem, selectedIds, profile, harnesses, delivery);
  installHooksForHarnesses(harnesses, delivery);
  console.log("PIPEDM_HEADLESS_RESULT=" + JSON.stringify(buildHeadlessSummary(pmdMode, ecosystem, profile, selectedIds, harnesses, delivery)));
}

async function runYesMode(options: InitOptions, detection: { ecosystem: Ecosystem; signals: string[]; recommendedScripts: string[] }, detectedHarnessNames: HarnessName[]) {
  const pmdMode: PmdMode = options.mode === "file" ? "file" : "agent";
  const ecosystem = resolveEcosystem(options.ecosystem, detection.ecosystem);
  const profile = resolveProfile(options.profile);
  const selectedIds = resolveScriptIds(options.scripts, detection.recommendedScripts);
  const allIds = getAllScripts().map((s) => s.id);
  const allResults = await testRunScripts(allIds, ecosystem);
  const tokenEstimates: Record<string, number> = {};
  for (const [id, result] of Object.entries(allResults)) {
    const lines = result.status === "success" ? result.lines : 0;
    const fallbackLines = SCRIPT_MAX_LINES[id] || 0;
    tokenEstimates[id] = estimateTokens(lines || fallbackLines, profile);
  }

  console.log();
  console.log(chalk.cyan(`🏴‍☠️ PipeMD — Auto-detected setup (${pmdMode} mode)`));
  if (detection.signals.length > 0) {
    console.log(chalk.dim("  Project detected:"));
    for (const signal of detection.signals) console.log(chalk.dim(`    • ${signal}`));
  }

  if (pmdMode === "file") {
    const outputFile = options.output || "pmd.md";
    console.log(chalk.dim(`  Mode: file`));
    console.log(chalk.dim(`  Output: ${outputFile}`));
    console.log(chalk.dim(`  Ecosystem: ${ecosystem}`));
    console.log(chalk.dim(`  Profile: ${profile}`));
    console.log(chalk.dim(`  Scripts: ${selectedIds.join(", ")}`));
    console.log();
    runInitFile(ecosystem, selectedIds, profile, outputFile);
    return;
  }

  const harnesses = resolveHarnessList(options.harnesses, detectedHarnessNames);
  const delivery = resolveDelivery(options.delivery);

  if (detectedHarnessNames.length > 0) {
    console.log(chalk.green("✅ Detected harnesses: " + detectedHarnessNames.join(", ")));
  } else {
    console.log(chalk.dim("  No AI harnesses detected in this project."));
  }
  console.log(chalk.dim(`  Harnesses: ${harnesses.length > 0 ? harnesses.join(", ") : "none (single-file mode)"}`));
  console.log(chalk.dim(`  Ecosystem: ${ecosystem}`));
  console.log(chalk.dim(`  Profile: ${profile}`));
  console.log(chalk.dim(`  Scripts: ${selectedIds.join(", ")}`));
  console.log();

  const harness: Harness = (VALID_HARNESSES.includes(options.harness as Harness) ? options.harness : "None") as Harness;
  const agent: AiAgent = (VALID_AGENTS.includes(options.agent as AiAgent) ? options.agent : "Generic") as AiAgent;

  if (agent !== "Generic" && { "Claude Code": ["claude"], "Cursor": ["cursor-agent"], "Aider": ["aider"], "Gemini": ["gemini"], "OpenClaw": ["openclaw"], "Hermes": ["hermes"] }[agent]) {
    console.log(chalk.dim("  Running test validation..."));
    const selectedResults: Record<string, any> = {};
    for (const id of selectedIds) { selectedResults[id] = allResults[id]; }
    const validatedIds = await aiValidateScripts(agent, selectedResults);
    console.log(chalk.green(`  AI validated scripts: ${validatedIds.join(", ")}`));
    console.log();
    runInit(agent, ecosystem, validatedIds, profile, harnesses, delivery);
  } else {
    runInit(agent, ecosystem, selectedIds, profile, harnesses, delivery);
  }

  installHooksForHarnesses(harnesses, delivery);
  if (harnesses.length > 0) printHarnessRouting(harnesses);
  await runHarness(harness, agent, ecosystem, selectedIds, profile, tokenEstimates);
}

async function runInteractive(options: InitOptions, detection: { ecosystem: Ecosystem; signals: string[]; recommendedScripts: string[] }, detectedHarnessNames: HarnessName[]) {
  console.log();
  console.log(chalk.cyan("🔍 Scanning workspace for AI agents..."));
  if (detectedHarnessNames.length > 0) {
    console.log(chalk.green("✅ Detected harnesses: " + detectedHarnessNames.join(", ")));
  } else {
    console.log(chalk.dim("  No AI harnesses detected. You can select harnesses manually."));
  }
  console.log();

  const PipeMD_ASCII = `
 ███████████   ███                     ██████   ██████ ██████████  
░░███░░░░░███ ░░░                     ░░██████ ██████ ░░███░░░░███ 
 ░███    ░███ ████  ████████   ██████  ░███░█████░███  ░███   ░░███
 ░██████████ ░░███ ░░███░░███ ███░░███ ░███░░███ ░███  ░███    ░███
 ░███░░░░░░   ░███  ░███ ░███░███████  ░███ ░░░  ░███  ░███    ░███
 ░███         ░███  ░███ ░███░███░░░   ░███      ░███  ░███    ███ 
 █████        █████ ░███████ ░░██████  █████     █████ ██████████  
░░░░░        ░░░░░  ░███░░░   ░░░░░░  ░░░░░     ░░░░░ ░░░░░░░░░░   
                    ░███                                           
                    █████                                          
                   ░░░░░                                           
                    
                    PipeMD — Interactive Setup
  `;

  console.log(chalk.yellow(PipeMD_ASCII));

  const modeAnswer = await prompts({
    type: "select",
    name: "mode",
    message: "What are you using PipeMD for?",
    choices: [
      { title: "Agent", description: "Live context for AI coding tools (OpenCode, Claude Code, Cursor…)", value: "agent" },
      { title: "File", description: "Generate context files on demand (CI, docs, review, ad-hoc)", value: "file" },
    ],
    initial: 0,
  });
  if (!modeAnswer.mode) { console.log(chalk.yellow("\nSetup cancelled.")); process.exit(1); }

  const selectedMode: PmdMode = modeAnswer.mode;
  let selectedHarnesses: HarnessName[] = [];
  let outputFile = "pmd.md";
  let interactiveDelivery: DeliveryMode = "active";

  if (selectedMode === "agent") {
    const harnessChoices = ALL_HARNESSES.map((name) => ({
      title: `${name} → ${HARNESS_TARGETS[name]}${(name === "Cursor" || name === "OpenClaw" || name === "Hermes" || name === "OS Agent") ? " (Legacy mode)" : ""}`,
      description: HARNESS_DESCRIPTIONS[name],
      value: name,
      selected: detectedHarnessNames.includes(name),
    }));
    const harnessAnswer = await prompts({
      type: "multiselect",
      name: "harnesses",
      message: "Select AI harnesses to configure (space to toggle, enter to confirm)",
      choices: harnessChoices,
      hint: "space to toggle. enter to confirm. Pre-selected = auto-detected.",
    });
    if (!harnessAnswer.harnesses) { console.log(chalk.yellow("\nSetup cancelled.")); process.exit(1); }
    selectedHarnesses = harnessAnswer.harnesses;
    warnConflictingTargets(selectedHarnesses);

    if (!options.delivery) {
      const deliveryResponse = await prompts({
        type: "select",
        name: "delivery",
        message: "How should PipeMD deliver context to your agent?",
        choices: [
          { title: "Passive", description: "Context rendered to file/pipe. No hooks. Zero agent overhead. Best for Cursor, Aider, CI/CD.", value: "passive" },
          { title: "Active (recommended)", description: "Fresh context injected via hooks on every tool call. Agent sees: crew locks, file errors, validation. Best for Claude Code, OpenCode, Gemini.", value: "active" },
          { title: "Expert", description: "Full control over injection rules. Configure per-hook behavior in injection.yml.", value: "expert" },
        ],
        initial: 1,
      });
      if (!deliveryResponse.delivery) { console.log(chalk.yellow("\nSetup cancelled.")); process.exit(1); }
      interactiveDelivery = deliveryResponse.delivery as DeliveryMode;
    } else {
      interactiveDelivery = resolveDelivery(options.delivery);
    }
  } else {
    const outputAnswer = await prompts({
      type: "text",
      name: "output",
      message: "Output file path (default: pmd.md)",
      initial: "pmd.md",
    });
    if (!outputAnswer.output) { console.log(chalk.yellow("\nSetup cancelled.")); process.exit(1); }
    outputFile = outputAnswer.output.trim() || "pmd.md";
  }

  if (detection.signals.length > 0) {
    console.log(chalk.bold("Detected in this project:"));
    for (const signal of detection.signals) console.log(chalk.dim(`  • ${signal}`));
    console.log();
  }

  const ecosystemChoices = [
    { title: "Node/TypeScript", value: "Node/TypeScript", detected: detection.ecosystem === "Node/TypeScript" },
    { title: "Python", value: "Python", detected: detection.ecosystem === "Python" },
    { title: "C/C++", value: "C-CPP", detected: detection.ecosystem === "C-CPP" },
    { title: "Rust", value: "Rust", detected: detection.ecosystem === "Rust" },
    { title: "Go", value: "Go", detected: detection.ecosystem === "Go" },
    { title: "DevOps", value: "DevOps", detected: detection.ecosystem === "DevOps" },
    { title: "Generic", value: "Generic", detected: detection.ecosystem === "Generic" },
  ];

  const ecosystemAnswer = await prompts({
    type: "select",
    name: "ecosystem",
    message: "What primary ecosystem is this project?",
    choices: ecosystemChoices.map((c) => ({
      title: c.detected ? `${c.title}  ✓ detected` : c.title,
      value: c.value,
    })),
    initial: VALID_ECOSYSTEMS.indexOf(detection.ecosystem),
  });
  if (!ecosystemAnswer.ecosystem) { console.log(chalk.yellow("\nSetup cancelled.")); process.exit(1); }

  const profileAnswer = await prompts({
    type: "select",
    name: "profile",
    message: "Select token budget profile",
    choices: VALID_PROFILES.map((p) => ({
      title: TOKEN_PROFILES[p].label,
      description: TOKEN_PROFILES[p].description,
      value: p,
    })),
    initial: 1,
  });
  if (!profileAnswer.profile) { console.log(chalk.yellow("\nSetup cancelled.")); process.exit(1); }

  const ecosystem: Ecosystem = ecosystemAnswer.ecosystem;
  const profile: TokenProfile = profileAnswer.profile;
  const allScripts = getAllScripts();
  const allIds = allScripts.map((s) => s.id);

  console.log();
  console.log(chalk.dim("  Estimating token budgets by running all scripts..."));
  const allResults = await testRunScripts(allIds, ecosystem);

  const tokenEstimates: Record<string, number> = {};
  for (const [id, result] of Object.entries(allResults)) {
    const lines = result.status === "success" ? result.lines : 0;
    const fallbackLines = SCRIPT_MAX_LINES[id] || 0;
    tokenEstimates[id] = estimateTokens(lines || fallbackLines, profile);
  }

  const recommendedSet = new Set(detection.recommendedScripts);

  console.log();
  renderPromptBlueprint(allScripts, allResults, recommendedSet, profile, "📋 PipeMD Script Budget — All Available Scripts");

  const categoryOrder = ["architecture", "project", "git", "quality", "db", "api", "frontend", "cpp", "rust", "go", "devops"] as const;
  const categoryLabels: Record<string, string> = {
    architecture: "🏗️  Architecture", project: "📁 Project", git: "🔀 Git",
    quality: "✅ Quality", db: "🗄️  Database", api: "🌐 API",
    frontend: "🎨 Frontend", cpp: "⚙️  C/C++", rust: "🦀 Rust",
    go: "🐹 Go", devops: "🐳 DevOps",
  };

  const choices: { title: string; value: string; description: string }[] = [];
  for (const cat of categoryOrder) {
    const catScripts = allScripts.filter((s) => s.category === cat);
    if (catScripts.length > 0) {
      choices.push({ title: `— ${categoryLabels[cat]} —`, value: `__header_${cat}`, description: "" });
      for (const s of catScripts) {
        const marker = recommendedSet.has(s.id) ? " ★" : "";
        const tokens = tokenEstimates[s.id] ?? 0;
        choices.push({
          title: `  ${s.label}${marker}`,
          value: s.id,
          description: recommendedSet.has(s.id) ? `${s.description} (~${tokens} tks) (recommended)` : `${s.description} (~${tokens} tks)`,
        });
      }
    }
  }

  const filteredChoices = choices.filter((c) => !c.value.startsWith("__header_"));
  const defaultIndices = detection.recommendedScripts
    .map((id) => filteredChoices.findIndex((c) => c.value === id))
    .filter((i) => i >= 0);

  let liveCounterLine = "";
  const updateLiveCounter = (selected: string[]) => {
    const total = selected.reduce((sum, id) => sum + (tokenEstimates[id] ?? 0), 0);
    liveCounterLine = `  Selected: ${selected.length} scripts (~${total} tokens) [${profile}]`;
  };
  updateLiveCounter(detection.recommendedScripts);

  const counterOffset = filteredChoices.length + 6;
  const scriptsAnswer = await prompts({
    type: "multiselect",
    name: "scripts",
    message: "Select context scripts to include (space to toggle, enter to confirm) ★ = recommended",
    choices: filteredChoices,
    initial: defaultIndices as unknown as number,
    hint: "- space to toggle. enter to confirm. ★ = auto-detected",
    onState(state) {
      if (Array.isArray(state.value)) {
        updateLiveCounter(state.value as string[]);
        process.stdout.write(`\x1b[${counterOffset}A\x1b[2K\r${chalk.cyan(liveCounterLine)}\x1b[${counterOffset}B`);
      }
    },
  });

  process.stdout.write(`\x1b[${counterOffset}A\x1b[2K\r\x1b[K\x1b[${counterOffset}B`);
  if (!scriptsAnswer.scripts) { console.log(chalk.yellow("\nSetup cancelled.")); process.exit(1); }

  const selectedIds: string[] = scriptsAnswer.scripts;
  const selectedScripts = allScripts.filter((s) => selectedIds.includes(s.id));
  const selectedResults: Record<string, any> = {};
  for (const id of selectedIds) { selectedResults[id] = allResults[id]; }

  console.log();
  console.log(chalk.cyan(liveCounterLine));
  console.log();
  renderPromptBlueprint(selectedScripts, selectedResults, new Set(), profile, "📋 PipeMD Script Budget — Your Selection");

  const failedIds = Object.entries(selectedResults)
    .filter(([, r]) => r.status === "error" || r.status === "empty" || r.status === "timeout")
    .map(([id]) => id);

  let finalIds: string[];
  if (failedIds.length > 0) {
    const idToLabel = new Map(allScripts.map((s) => [s.id, s.label]));
    const confirmChoices = selectedIds.map((id) => {
      const isFailed = failedIds.includes(id);
      return {
        title: `${isFailed ? "❌" : "✅"} ${idToLabel.get(id) || id}${isFailed ? " (failed)" : ""}`,
        value: id,
        disabled: isFailed,
      };
    });
    const confirmAnswer = await prompts({
      type: "multiselect",
      name: "scripts",
      message: "Review the test results. Uncheck any scripts you want to remove before finalizing. Failed scripts are pre-unchecked.",
      choices: confirmChoices,
      initial: confirmChoices.map((c, i) => !c.disabled ? i : -1).filter((i) => i >= 0) as unknown as number,
      hint: "space to toggle. enter to confirm.",
    });
    if (!confirmAnswer.scripts) { console.log(chalk.yellow("\nSetup cancelled.")); process.exit(1); }
    finalIds = confirmAnswer.scripts;
  } else {
    finalIds = selectedIds;
  }

  if (selectedMode === "agent") {
    const harnessPromptAnswer = await prompts({
      type: "select",
      name: "harness",
      message: "Select AI harness to generate your instruction file",
      choices: [
        { title: "OpenCode",    description: "Generate via opencode CLI",  value: "OpenCode" },
        { title: "Claude Code", description: "Generate via claude CLI",    value: "Claude Code" },
        { title: "Cursor",      description: "Generate via cursor-agent",  value: "Cursor" },
        { title: "Gemini",      description: "Generate via gemini CLI",    value: "Gemini" },
        { title: "OpenClaw",    description: "Generate via openclaw CLI",  value: "OpenClaw" },
        { title: "Hermes",      description: "Generate via hermes CLI",    value: "Hermes" },
        { title: "None",        description: "Skip — set up manually later", value: "None" },
      ],
      initial: 0,
    });
    if (!harnessPromptAnswer.harness) { console.log(chalk.yellow("\nSetup cancelled.")); process.exit(1); }

    const harness: Harness = harnessPromptAnswer.harness;
    const agent: AiAgent = resolveAgent(selectedHarnesses);

    runInit(agent, ecosystem, finalIds, profile, selectedHarnesses, interactiveDelivery);
    installHooksForHarnesses(selectedHarnesses, interactiveDelivery);
    if (selectedHarnesses.length > 0) printHarnessRouting(selectedHarnesses);
    await runHarness(harness, agent, ecosystem, finalIds, profile, tokenEstimates);
  } else {
    runInitFile(ecosystem, finalIds, profile, outputFile);
  }
}

export const initCommand = new Command("init")
  .description("Configure PipeMD for this project")
  .option("-y, --yes", "Use auto-detected defaults, skip all prompts")
  .option("--mode <mode>", "PipedMD mode: agent (live context for AI tools) or file (generate files on demand)")
  .option("--agent <name>", "AI agent (Claude Code, Cursor, Aider, Gemini, Generic, OpenClaw, Hermes) — legacy, use --harnesses instead")
  .option("--ecosystem <name>", "Ecosystem (Node/TypeScript, Python, Generic)")
  .option("--scripts <list>", "Comma-separated script IDs (e.g. tree,git-status,todos)")
  .option("--profile <name>", "Token profile (low, medium, high, xhigh, unlimited)")
  .option("--harness <name>", "AI harness for instruction file generation (OpenCode, Claude Code, Cursor, None)")
  .option("--harnesses <list>", "Comma-separated harness names to configure (OpenCode,ClaudeCode,Cursor,Aider,OpenClaw,Hermes)")
  .option("--output <file>", "Output file for file mode (default: pmd.md)")
  .option("--delivery <mode>", "context delivery mode: passive | active | expert")
  .option("--headless", "Zero-interaction mode for AI agents: auto-detect everything, skip tests, print JSON summary")
  .action(async (options: InitOptions) => {
    const detection = detectProject();
    const harnessDetection = detectHarnesses();
    const detectedHarnessNames = harnessDetection.filter(h => h.detected).map(h => h.name);

    if (options.headless) {
      await runHeadless(options, detection, detectedHarnessNames);
    } else if (options.yes) {
      await runYesMode(options, detection, detectedHarnessNames);
    } else {
      await runInteractive(options, detection, detectedHarnessNames);
    }
  });
