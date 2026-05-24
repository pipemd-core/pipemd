import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { log, errMsg } from "./logger.js";

export type HarnessName =
  | "OpenCode"
  | "Claude Code"
  | "Cursor"
  | "Aider"
  | "Gemini"
  | "OpenClaw"
  | "Hermes"
  | "OS Agent";

export interface HarnessDetection {
  name: HarnessName;
  targetFile: string;
  detected: boolean;
  signals: string[];
  needsLegacyMode: boolean;
}

export const HARNESS_TARGETS: Record<HarnessName, string> = {
  "OpenCode": "AGENTS.md",
  "Claude Code": "CLAUDE.md",
  "Aider": "CONVENTIONS.md",
  "Gemini": "AI_CONTEXT.md",
  "Cursor": ".cursorrules",
  "OpenClaw": "WORKSPACE_CONTEXT.md",
  "Hermes": "WORKSPACE_CONTEXT.md",
  "OS Agent": "AGENTS.md",
};

export const ALL_HARNESSES: HarnessName[] = [
  "OpenCode",
  "Claude Code",
  "Cursor",
  "Aider",
  "Gemini",
  "OpenClaw",
  "Hermes",
  "OS Agent",
];

function hasInPath(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch (err: unknown) { log.debug(`hasInPath(${cmd}) failed: ${errMsg(err)}`); return false; }
}

function hasNpmGlobal(pkg: string): boolean {
  try {
    const result = execFileSync("npm", ["list", "-g", pkg, "--depth=0"], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return result.includes(pkg);
  } catch (err: unknown) { log.debug(`hasNpmGlobal(${pkg}) failed: ${errMsg(err)}`); return false; }
}

function hasNpmDevDep(pkg: string, cwd: string): boolean {
  const pkgPath = path.join(cwd, "package.json");
  try {
    const content = fs.readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(content);
    const deps = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
    return pkg in deps;
  } catch (err: unknown) { log.debug(`hasNpmDevDep(${pkg}) failed: ${errMsg(err)}`); return false; }
}

export function detectHarnesses(cwd: string = process.cwd()): HarnessDetection[] {
  const results: HarnessDetection[] = [];

  const has = (file: string) => fs.existsSync(path.join(cwd, file));

  results.push(detectOpenCode(cwd, has));
  results.push(detectClaudeCode(cwd, has));
  results.push(detectCursor(cwd, has));
  results.push(detectAider(cwd, has));
  results.push(detectGemini(cwd, has));
  results.push(detectOpenClaw(cwd, has));
  results.push(detectHermes(cwd, has));

  const codingDetected = results.filter((r) => r.detected);
  if (codingDetected.length === 0) {
    results.push(detectOSAgent(cwd, has));
  } else {
    results.push({
      name: "OS Agent",
      targetFile: HARNESS_TARGETS["OS Agent"],
      detected: false,
      signals: [],
      needsLegacyMode: true,
    });
  }

  return results;
}

function detectOpenCode(cwd: string, has: (f: string) => boolean): HarnessDetection {
  const signals: string[] = [];

  if (has("opencode.json")) signals.push("opencode.json found");
  if (has("opencode.json5")) signals.push("opencode.json5 found");

  const homeConfig = path.join(os.homedir(), ".config", "opencode");
  if (fs.existsSync(homeConfig)) signals.push("~/.config/opencode found");

  if (hasInPath("opencode")) signals.push("opencode in PATH");

  return {
    name: "OpenCode",
    targetFile: HARNESS_TARGETS["OpenCode"],
    detected: signals.length > 0,
    signals,
    needsLegacyMode: false,
  };
}

function detectClaudeCode(cwd: string, has: (f: string) => boolean): HarnessDetection {
  const signals: string[] = [];

  if (has("clauderc.toml")) signals.push("clauderc.toml found");
  if (has(".claude.json")) signals.push(".claude.json found");
  if (has("CLAUDE.md")) signals.push("CLAUDE.md found");

  if (hasNpmDevDep("@anthropic-ai/claude-code", cwd)) {
    signals.push("@anthropic-ai/claude-code in package.json");
  }
  if (hasNpmGlobal("@anthropic-ai/claude-code")) {
    signals.push("@anthropic-ai/claude-code installed globally");
  }
  if (hasInPath("claude")) signals.push("claude in PATH");

  return {
    name: "Claude Code",
    targetFile: HARNESS_TARGETS["Claude Code"],
    detected: signals.length > 0,
    signals,
    needsLegacyMode: false,
  };
}

function detectCursor(cwd: string, has: (f: string) => boolean): HarnessDetection {
  const signals: string[] = [];

  if (has(".cursor")) signals.push(".cursor/ directory found");
  if (has(".cursorrules")) signals.push(".cursorrules found");

  const cursorRulesDir = path.join(cwd, ".cursor", "rules");
  if (fs.existsSync(cursorRulesDir)) signals.push(".cursor/rules/ found");

  if (hasInPath("cursor")) signals.push("cursor in PATH");

  return {
    name: "Cursor",
    targetFile: HARNESS_TARGETS["Cursor"],
    detected: signals.length > 0,
    signals,
    needsLegacyMode: true,
  };
}

function detectAider(cwd: string, has: (f: string) => boolean): HarnessDetection {
  const signals: string[] = [];

  if (has(".aider.conf.yml")) signals.push(".aider.conf.yml found");
  if (has(".aider.tags.cache.v3")) signals.push(".aider.tags.cache.v3 found");

  if (hasInPath("aider")) signals.push("aider in PATH");

  return {
    name: "Aider",
    targetFile: HARNESS_TARGETS["Aider"],
    detected: signals.length > 0,
    signals,
    needsLegacyMode: false,
  };
}

function detectGemini(cwd: string, has: (f: string) => boolean): HarnessDetection {
  const signals: string[] = [];

  if (has(".geminirc")) signals.push(".geminirc found");
  if (has("gemini.json")) signals.push("gemini.json found");
  if (has(".gemini")) signals.push(".gemini/ directory found");

  const homeConfig = path.join(os.homedir(), ".config", "gemini");
  if (fs.existsSync(homeConfig)) signals.push("~/.config/gemini found");

  if (hasInPath("gemini")) signals.push("gemini in PATH");

  if (has("AI_CONTEXT.md")) signals.push("AI_CONTEXT.md found");

  return {
    name: "Gemini",
    targetFile: HARNESS_TARGETS["Gemini"],
    detected: signals.length > 0,
    signals,
    needsLegacyMode: false,
  };
}

function detectOpenClaw(cwd: string, has: (f: string) => boolean): HarnessDetection {
  const signals: string[] = [];

  if (has(".openclaw")) signals.push(".openclaw/ directory found");
  if (has("openclaw.yml")) signals.push("openclaw.yml found");
  if (has("openclaw.yaml")) signals.push("openclaw.yaml found");
  if (has(".openclawrc")) signals.push(".openclawrc found");

  const homeConfig = path.join(os.homedir(), ".config", "openclaw");
  if (fs.existsSync(homeConfig)) signals.push("~/.config/openclaw found");

  if (hasInPath("openclaw")) signals.push("openclaw in PATH");

  if (has("WORKSPACE_CONTEXT.md")) signals.push("WORKSPACE_CONTEXT.md found");

  return {
    name: "OpenClaw",
    targetFile: HARNESS_TARGETS["OpenClaw"],
    detected: signals.length > 0,
    signals,
    needsLegacyMode: true,
  };
}

function detectHermes(cwd: string, has: (f: string) => boolean): HarnessDetection {
  const signals: string[] = [];

  if (has(".hermes")) signals.push(".hermes/ directory found");
  if (has("hermes.yml")) signals.push("hermes.yml found");
  if (has("hermes.yaml")) signals.push("hermes.yaml found");
  if (has(".hermesrc")) signals.push(".hermesrc found");

  const homeConfig = path.join(os.homedir(), ".config", "hermes");
  if (fs.existsSync(homeConfig)) signals.push("~/.config/hermes found");

  if (hasInPath("hermes")) signals.push("hermes in PATH");

  if (has("WORKSPACE_CONTEXT.md")) signals.push("WORKSPACE_CONTEXT.md found");

  return {
    name: "Hermes",
    targetFile: HARNESS_TARGETS["Hermes"],
    detected: signals.length > 0,
    signals,
    needsLegacyMode: true,
  };
}

function detectOSAgent(cwd: string, has: (f: string) => boolean): HarnessDetection {
  const signals: string[] = [];

  if (has("WORKSPACE_CONTEXT.md")) signals.push("WORKSPACE_CONTEXT.md found");
  if (has("AGENTS.md")) signals.push("AGENTS.md found");

  return {
    name: "OS Agent",
    targetFile: HARNESS_TARGETS["OS Agent"],
    detected: true,
    signals: ["No coding-specific harness detected — defaulting to OS Agent mode"],
    needsLegacyMode: true,
  };
}