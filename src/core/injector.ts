import fs from "node:fs";
import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { log } from "./logger.js";
import { COMMAND_TIMEOUT_MS } from "../config.js";
import type { PipeConfig } from "../config.js";

const execAsync = promisify(exec);

const TAG_OPEN_RE = /<!--\s*pmd:\s*([\w-]+)\s*-->/;
const TAG_CLOSE_RE = /<!--\s*\/pmd\s*-->/;
const BLOCK_RE = /<!--\s*pmd:\s*([\w-]+)\s*-->\n?([\s\S]*?)<!--\s*\/pmd\s*-->/g;

const ERROR_BLOCK = (commandName: string, cmd: string, detail: string) =>
  `⚠️ PipeMD Error: Command '${commandName}' failed to execute.\n${cmd}: ${detail}\nCheck .pipemd/daemon.log`;

export function injectFile(filePath: string, config: PipeConfig, outputPath?: string): boolean {
  const content = fs.readFileSync(filePath, "utf-8");
  const updated = injectContent(content, config);
  if (updated === null) return false;
  const target = outputPath || filePath;
  const tmp = target + `.tmp-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, updated, { mode: 0o644 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o444);
  return true;
}

export function injectContent(content: string, config: PipeConfig): string | null {
  let changed = false;
  const result = content.replace(BLOCK_RE, (_match, commandName: string, inner: string) => {
    const cmd = config.commands[commandName];
    if (!cmd) return _match;
    const output = runCommandSync(commandName, cmd);
    const replacement = buildBlock(commandName, output);
    if (replacement !== `<!-- pmd: ${commandName} -->\n${inner}<!-- /pmd -->`) {
      changed = true;
    }
    return replacement;
  });
  return changed ? result : null;
}

export async function renderContentAsync(template: string, config: PipeConfig, maxLines?: number): Promise<string> {
  const commands = new Map<string, string>();
  const tagRe = /<!--\s*pmd:\s*([\w-]+)\s*-->/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(template)) !== null) {
    const name = match[1];
    const cmd = config.commands[name];
    commands.set(name, cmd || "");
  }

  if (commands.size === 0) return template;

  const results = new Map<string, string | null>();
  await Promise.allSettled(
    Array.from(commands.entries()).map(async ([name, cmd]) => {
      if (!cmd) {
        results.set(name, "");
        return;
      }
      try {
        const { stdout } = await execAsync(cmd, { encoding: "utf-8", timeout: COMMAND_TIMEOUT_MS, cwd: process.cwd() });
        const output = stdout.trim();
        results.set(name, output ? buildBlock(name, output) : "");
      } catch (err: any) {
        const detail = err.stderr?.trimEnd() || err.message || "Unknown error";
        results.set(name, buildBlock(name, ERROR_BLOCK(name, cmd, detail)));
      }
    })
  );

  const blockRe = /<!--\s*pmd:\s*([\w-]+)\s*-->[\s\S]*?<!--\s*\/pmd\s*-->\n?/g;
  const rendered = template.replace(blockRe, (_match, name: string) => {
    const replacement = results.get(name);
    if (!replacement) {
      return "";
    }
    return replacement;
  });

  const trimmed = rendered.trim();

  if (maxLines && maxLines !== Infinity) {
    const lines = trimmed.split("\n");
    if (lines.length > maxLines) {
      const truncated = lines.slice(0, maxLines);
      truncated.push(`\n... (truncated from ${lines.length} to ${maxLines} lines by token profile)`);
      return truncated.join("\n");
    }
  }

  return trimmed;
}

function runCommandSync(commandName: string, cmd: string): string {
  try {
    const out = execSync(cmd, { encoding: "utf-8", timeout: COMMAND_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"], cwd: process.cwd() });
    return out.trimEnd();
  } catch (err: any) {
    const detail = err.stderr?.trimEnd() || err.message || "Unknown error";
    return ERROR_BLOCK(commandName, cmd, detail);
  }
}

function buildBlock(commandName: string, output: string): string {
  return `<!-- pmd: ${commandName} -->\n\`\`\`\n${output}\n\`\`\`\n<!-- /pmd -->`;
}

const EMPTY_BLOCK = (commandName: string) =>
  `<!-- pmd: ${commandName} -->\n\`\`\`\n\n\`\`\`\n<!-- /pmd -->`;

export function reverseInject(renderedContent: string, template: string): string {
  const blockRe = /<!--\s*pmd:\s*([\w-]+)\s*-->[\s\S]*?<!--\s*\/pmd\s*-->/g;

  const templateBlocks = new Map<string, string>();
  const tRe = /<!--\s*pmd:\s*([\w-]+)\s*-->[\s\S]*?<!--\s*\/pmd\s*-->/g;
  let tMatch: RegExpExecArray | null;
  while ((tMatch = tRe.exec(template)) !== null) {
    templateBlocks.set(tMatch[1], tMatch[0]);
  }

  const result = renderedContent.replace(blockRe, (_match, commandName: string) => {
    if (templateBlocks.has(commandName)) {
      return templateBlocks.get(commandName)!;
    }
    return EMPTY_BLOCK(commandName);
  });

  return result;
}
