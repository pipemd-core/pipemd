import { execFile } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";
import type { Ecosystem } from "../../core/detect.js";
import type { TokenProfile } from "../../config.js";
import {
  TOKEN_PROFILES,
  SCRIPT_MAX_LINES,
  estimateTokens,
  isTrimmed,
  HARNESS_CLI,
} from "./constants.js";
import type { ScriptDef, RunResult, AiAgent, Harness } from "./constants.js";
import { getAllScripts } from "./scripts.js";

const execFileAsync = promisify(execFile);

export function extractComposeFiles(stdout: string): string[] {
  return stdout.split("\n")
    .filter((line: string) => line.startsWith("### "))
    .map((line: string) => line.replace(/^### /, "").trim())
    .filter(Boolean);
}

export function renderPromptBlueprint(
  scripts: ScriptDef[],
  allResults: Record<string, RunResult>,
  recommended: Set<string>,
  profile: TokenProfile,
  title: string,
): void {
  const statusLabel = (s: string): string => {
    switch (s) {
      case "success":  return "ok";
      case "empty":    return "empty";
      case "error":    return "ERR";
      case "timeout":  return "TMO";
      default:         return "—";
    }
  };

  let totalTokens = 0;
  let successCount = 0;
  let trimmedCount = 0;
  let emptyCount = 0;
  let errorCount = 0;

  type Row = { label: string; tokens: number; status: string; trimmed: string; rec: boolean; category: string; detail?: string };
  const rows: Row[] = [];

  const COMMON_CATEGORIES = new Set(["architecture", "project", "git", "quality"]);
  const CATEGORY_LABELS: Record<string, string> = {
    architecture: "Architecture",
    project: "Common",
    git: "Common",
    quality: "Common",
    db: "Database",
    api: "API",
    frontend: "Frontend",
    cpp: "C/C++",
    rust: "Rust",
    go: "Go",
    devops: "DevOps",
  };
  const CATEGORY_ORDER = ["architecture", "project", "git", "quality", "db", "api", "frontend", "cpp", "rust", "go", "devops"];

  for (const s of scripts) {
    const result = allResults[s.id];
    const lines = result?.status === "success" ? result.lines : 0;
    const fallbackLines = SCRIPT_MAX_LINES[s.id] ?? 50;
    const effectiveLines = lines > 0 ? lines : (result?.status === "success" ? lines : fallbackLines);
    const tokens = result?.status === "success" || result?.status === "empty"
      ? estimateTokens(effectiveLines, profile)
      : estimateTokens(fallbackLines, profile);
    const trimmed = result?.status === "success" ? isTrimmed(s.id, result.lines, profile) : false;
    const rec = recommended.has(s.id);

    if (result?.status === "success") successCount++;
    if (trimmed) trimmedCount++;
    if (result?.status === "empty") emptyCount++;
    if (result?.status === "error" || result?.status === "timeout") errorCount++;

    let detail: string | undefined;
    if (s.id === "compose" && result?.status === "success" && result.stdout) {
      const files = extractComposeFiles(result.stdout);
      if (files.length > 0) {
        const maxShow = 8;
        const shown = files.slice(0, maxShow);
        const suffix = files.length > maxShow ? ` +${files.length - maxShow} more` : "";
        detail = `${shown.join(", ")}${suffix}`;
      }
    }

    totalTokens += tokens;
    rows.push({
      label: s.label,
      tokens,
      status: result ? statusLabel(result.status) : "—",
      trimmed: result?.status === "success" ? (trimmed ? "trim" : "full") : (result?.status === "error" || result?.status === "timeout" ? "n/a" : "—"),
      rec,
      category: s.category,
      detail,
    });
  }

  const colLabel = 26;
  const colTokens = 8;
  const colStatus = 5;
  const colTrim = 5;
  const rowWidth = colLabel + colTokens + colStatus + colTrim + 5;

  console.log();
  console.log(chalk.bold(`  ${title}`));
  console.log(chalk.dim(`  Profile: ${TOKEN_PROFILES[profile].label} - ${TOKEN_PROFILES[profile].description}`));
  console.log(chalk.dim("  " + "─".repeat(rowWidth)));

  const groupOrder: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const group = COMMON_CATEGORIES.has(cat) ? "Common" : (CATEGORY_LABELS[cat] ?? cat);
    if (!groupOrder.includes(group)) groupOrder.push(group);
  }

  for (const group of groupOrder) {
    const groupRows = rows.filter((r) => {
      const g = COMMON_CATEGORIES.has(r.category) ? "Common" : (CATEGORY_LABELS[r.category] ?? r.category);
      return g === group;
    });
    if (groupRows.length === 0) continue;
    console.log(chalk.dim(`  ── ${group} ${"─".repeat(Math.max(0, rowWidth - group.length - 4))}`));
    for (const row of groupRows) {
      const marker = row.rec ? chalk.cyan("*") : " ";
      const labelStr = `${marker} ${row.label.padEnd(colLabel - 2)}`;
      const tokenStr = `${row.tokens}`.padStart(colTokens);
      const statusStr = row.status.padEnd(colStatus);
      const trimStr = row.trimmed.padEnd(colTrim);
      const statusColor = row.status === "ok" ? chalk.green : (row.status === "ERR" || row.status === "TMO" ? chalk.red : (row.status === "empty" ? chalk.yellow : chalk.reset));
      const trimColor = row.trimmed === "trim" ? chalk.yellow : (row.trimmed === "full" ? chalk.green : chalk.reset);
      console.log(`  ${labelStr}${tokenStr} tks  ${statusColor(statusStr)}  ${trimColor(trimStr)}`);
      if (row.detail) {
        console.log(chalk.dim(`    ↳ ${row.detail}`));
      }
    }
  }

  console.log(chalk.dim("  " + "─".repeat(rowWidth)));

  const pctOfContext = Math.round((totalTokens / 200000) * 100);
  const profileLabel = TOKEN_PROFILES[profile].label;
  console.log(chalk.bold(`  Total: ~${totalTokens.toLocaleString()} tks (${pctOfContext}% of 200K ctx)  Profile: ${profileLabel}`));

  const healthParts: string[] = [];
  if (successCount > 0) healthParts.push(chalk.green(`${successCount} ok`));
  if (trimmedCount > 0) healthParts.push(chalk.yellow(`${trimmedCount} trimmed`));
  if (emptyCount > 0) healthParts.push(chalk.yellow(`${emptyCount} empty`));
  if (errorCount > 0) healthParts.push(chalk.red(`${errorCount} failed`));
  if (healthParts.length > 0) {
    console.log(`  Health: ${healthParts.join(chalk.dim(" | "))}`);
  }
  console.log();
}

export function buildHarnessPrompt(
  agent: AiAgent,
  ecosystem: Ecosystem,
  selectedIds: string[],
  profile: TokenProfile,
  tokenEstimates: Record<string, number>,
): string {
  const allScripts = getAllScripts();
  const selected = allScripts.filter((s) => selectedIds.includes(s.id));
  const mdFile = { "Claude Code": "CLAUDE.md", "Cursor": ".cursorrules", "Aider": "CONVENTIONS.md", "Gemini": "AI_CONTEXT.md", "OpenClaw": "WORKSPACE_CONTEXT.md", "Hermes": "WORKSPACE_CONTEXT.md", "Generic": "AGENTS.md" }[agent] || "AI_CONTEXT.md";

  const scriptLines = selected.map((s) => {
    const tokens = tokenEstimates[s.id] ?? 0;
    return `- ${s.label} (~${tokens} tokens): ${s.description}`;
  }).join("\n");

  return `Create or update the instruction file (${mdFile}) for this repository.

This project uses PipeMD — a live context injection daemon for AI coding agents.

## PipeMD Rules to Include in the Instruction File

1. The context file (${mdFile}) is maintained by PipeMD. It refreshes automatically via a named pipe.
2. Content inside <!-- pmd: --> blocks is LIVE-INJECTED and read-only — the daemon overwrites it every cycle.
3. Everything outside <!-- pmd: --> blocks is editable. Edits persist via bidirectional write-back.
4. Edits above <!-- pmd-context --> route to .pipemd/base.md. Edits below it route to .pipemd/template.md.
5. Prefer reading <!-- pmd: --> blocks over running shell commands for project context (tree, deps, git status, etc.)
6. Token profile: ${profile} (${TOKEN_PROFILES[profile].description})

## Active Scripts

${scriptLines}

## How to Investigate

Read the highest-value sources first:
- README*, root manifests, workspace config, lockfiles
- build, test, lint, formatter, typecheck, and codegen config
- CI workflows and pre-commit / task runner config
- existing instruction files (AGENTS.md, CLAUDE.md, .cursor/rules/, .cursorrules, .github/copilot-instructions.md)
- ${mdFile} (the PipeMD-managed context file)

If architecture is still unclear after reading config and docs, inspect a small number of representative code files to find the real entrypoints, package boundaries, and execution flow.

Prefer executable sources of truth over prose. If docs conflict with config or scripts, trust the executable source.

## What to Extract

Look for the highest-signal facts for an agent working in this repo:
- exact developer commands, especially non-obvious ones
- how to run a single test, a single package, or a focused verification step
- required command order when it matters, such as lint -> typecheck -> test
- monorepo or multi-package boundaries, ownership of major directories, and the real app/library entrypoints
- framework or toolchain quirks: generated code, migrations, codegen, build artifacts, special env loading, dev servers, infra deploy flow
- repo-specific style or workflow conventions that differ from defaults
- testing quirks: fixtures, integration test prerequisites, snapshot workflows, required services, flaky or expensive suites
- important constraints from existing instruction files worth preserving

## Writing Rules

Include only high-signal, repo-specific guidance such as:
- exact commands and shortcuts the agent would otherwise guess wrong
- architecture notes that are not obvious from filenames
- conventions that differ from language or framework defaults
- setup requirements, environment quirks, and operational gotchas
- references to existing instruction sources that matter
- PipeMD awareness: how <!-- pmd: --> blocks work, what data is live vs. static, how edits route via <!-- pmd-context -->

Exclude:
- generic software advice
- long tutorials or exhaustive file trees
- obvious language conventions
- speculative claims or anything you could not verify
- content better stored in another file referenced via opencode.json instructions

When in doubt, omit.

Prefer short sections and bullets. If the repo is simple, keep the file simple. If the repo is large, summarize the few structural facts that actually change how an agent should work.

If ${mdFile} already exists, improve it in place rather than rewriting blindly. Preserve verified useful guidance, delete fluff or stale claims, and reconcile it with the current codebase. Make sure PipeMD-specific rules are integrated naturally into the existing instructions, not just appended at the end.`;
}

export async function runHarness(
  harness: Harness,
  agent: AiAgent,
  ecosystem: Ecosystem,
  selectedIds: string[],
  profile: TokenProfile,
  tokenEstimates: Record<string, number>,
): Promise<void> {
  if (harness === "None") return;

  const cliArgs = HARNESS_CLI[harness];
  if (!cliArgs) {
    console.log(chalk.yellow(`  ⚠ No CLI command for harness: ${harness}. Skipping.`));
    console.log(chalk.dim("  You can manually run the harness prompt later."));
    return;
  }

  const prompt = buildHarnessPrompt(agent, ecosystem, selectedIds, profile, tokenEstimates);
  const mdFile = { "Claude Code": "CLAUDE.md", "Cursor": ".cursorrules", "Aider": "CONVENTIONS.md", "Gemini": "AI_CONTEXT.md", "OpenClaw": "WORKSPACE_CONTEXT.md", "Hermes": "WORKSPACE_CONTEXT.md", "Generic": "AGENTS.md" }[agent] || "AI_CONTEXT.md";

  console.log();
  console.log(chalk.bold(`🤖 Launching ${harness} to generate ${mdFile}...`));
  console.log(chalk.dim(`  Command: ${cliArgs.join(" ")} -p '<prompt>'`));
  console.log();

  try {
    const { stdout } = await execFileAsync(cliArgs[0], [...cliArgs.slice(1), "-p", prompt], {
      encoding: "utf-8",
      timeout: 120000,
      cwd: process.cwd(),
    });

    console.log(chalk.green(`✔ ${harness} completed.`));
    if (stdout.trim()) {
      console.log(chalk.dim("  Output preview:"));
      console.log(chalk.dim(stdout.trim().slice(0, 200)));
    }
    console.log();
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ ${harness} execution failed: ${err.message}`));
    console.log(chalk.dim("  The PipeMD setup is complete. You can manually generate the instruction file later."));
    console.log();
    console.log(chalk.dim("  Harness prompt (copy-paste into your AI tool):"));
    console.log(chalk.dim("─".repeat(50)));
    console.log(prompt);
    console.log(chalk.dim("─".repeat(50)));
  }
}
