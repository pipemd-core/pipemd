import fs from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { COMMAND_TIMEOUT_MS } from "../config.js";
import type { PipeConfig } from "../config.js";

const execFileAsync = promisify(execFile);

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function parseCommand(cmd: string): { bin: string; args: string[]; env: Record<string, string> } {
  const parts = cmd.split(/\s+/);
  const env: Record<string, string> = {};
  let i = 0;
  while (i < parts.length && ENV_ASSIGN_RE.test(parts[i])) {
    const eq = parts[i].indexOf("=");
    env[parts[i].slice(0, eq)] = parts[i].slice(eq + 1);
    i++;
  }
  return { bin: parts[i], args: parts.slice(i + 1), env };
}

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
  const result = content.replace(BLOCK_RE, (_match, commandName: string, _inner: string) => {
    const cmd = config.commands[commandName];
    if (!cmd) return _match;
    const output = runCommandSync(commandName, cmd, config);
    const replacement = buildBlock(commandName, output);
    if (replacement !== _match) {
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
        const { bin, args, env: cmdEnv } = parseCommand(cmd);
        const timeout = config.commandTimeouts?.[name] ?? COMMAND_TIMEOUT_MS;
        const { stdout } = await execFileAsync(bin, args, { encoding: "utf-8", timeout, cwd: process.cwd(), env: { ...process.env, ...cmdEnv } });
        const output = stdout.trim();
        results.set(name, output ? buildBlock(name, output) : "");
      } catch (err: unknown) {
        const execErr = err as { stderr?: string; message?: string; killed?: boolean; signal?: string } | null;
        if (execErr?.killed || execErr?.signal === "SIGTERM") {
          results.set(name, "");
        } else {
          const detail = execErr?.stderr?.trimEnd() || execErr?.message || "Unknown error";
          results.set(name, buildBlock(name, ERROR_BLOCK(name, cmd, detail)));
        }
      }
    })
  );

  const blockRe = /<!--\s*pmd:\s*([\w-]+)\s*-->[\s\S]*?<!--\s*\/pmd\s*-->\n?/g;

  const allMatches: { start: number; end: number; name: string }[] = [];
  let bMatch: RegExpExecArray | null;
  while ((bMatch = blockRe.exec(template)) !== null) {
    allMatches.push({ start: bMatch.index, end: bMatch.index + bMatch[0].length, name: bMatch[1] });
  }

  const lastIdx = new Map<string, number>();
  for (let i = 0; i < allMatches.length; i++) {
    lastIdx.set(allMatches[i].name, i);
  }
  const surviving = new Set(lastIdx.values());

  let rendered = "";
  let pos = 0;
  for (let i = 0; i < allMatches.length; i++) {
    const m = allMatches[i];
    rendered += template.slice(pos, m.start);
    if (surviving.has(i)) {
      const replacement = results.get(m.name);
      rendered += replacement ?? "";
    }
    pos = m.end;
  }
  rendered += template.slice(pos);

  rendered = rendered.replace(/^### .*\n+(?=(?:### |---|$))/gm, "");

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

function runCommandSync(commandName: string, cmd: string, config?: PipeConfig): string {
  try {
    const { bin, args, env: cmdEnv } = parseCommand(cmd);
    const timeout = config?.commandTimeouts?.[commandName] ?? COMMAND_TIMEOUT_MS;
    const out = execFileSync(bin, args, { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"], cwd: process.cwd(), env: { ...process.env, ...cmdEnv } });
    return out.trimEnd();
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string } | null;
    const detail = execErr?.stderr?.trimEnd() || execErr?.message || "Unknown error";
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
