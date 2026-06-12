import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";
import { log, errMsg } from "../../core/logger.js";
import type { Ecosystem } from "../../core/detect.js";
import {
  SCRIPTS_ROOT,
  SCRIPT_LIBRARY,
  ECOSYSTEM_DIR_MAP,
  TEST_RUN_TIMEOUT_MS,
} from "./constants.js";
import type { ScriptDef, RunResult, AiAgent } from "./constants.js";
import { SCRIPT_COMPANIONS } from "./constants.js";

const execFileAsync = promisify(execFile);

export function loadScriptContent(ecosystem: Ecosystem, scriptFile: string): string | null {
  const dir = ECOSYSTEM_DIR_MAP[ecosystem];
  const paths = [
    path.join(SCRIPTS_ROOT, dir, scriptFile),
    path.join(SCRIPTS_ROOT, "Shared", scriptFile),
    path.join(SCRIPTS_ROOT, "DevOps", scriptFile),
  ];
  for (const p of paths) {
    try {
      return fs.readFileSync(p, "utf-8");
    } catch (err: unknown) {
      log.debug(`load script ${p}: ${errMsg(err)}`);
    }
  }
  return null;
}

export function getAllScripts(): ScriptDef[] {
  return [
    ...SCRIPT_LIBRARY.architecture,
    ...SCRIPT_LIBRARY.project,
    ...SCRIPT_LIBRARY.git,
    ...SCRIPT_LIBRARY.quality,
    ...SCRIPT_LIBRARY.db,
    ...SCRIPT_LIBRARY.api,
    ...SCRIPT_LIBRARY.frontend,
    ...SCRIPT_LIBRARY.cpp,
    ...SCRIPT_LIBRARY.rust,
    ...SCRIPT_LIBRARY.go,
    ...SCRIPT_LIBRARY.devops,
    ...SCRIPT_LIBRARY.crew,
    ...SCRIPT_LIBRARY.context,
  ];
}

export async function testRunScripts(
  selectedIds: string[],
  ecosystem: Ecosystem,
): Promise<Record<string, RunResult>> {
  const results: Record<string, RunResult> = {};
  const allScripts = getAllScripts();
  const selected = allScripts.filter((s) => selectedIds.includes(s.id));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipemd-test-"));

  try {
    const libContent = loadScriptContent(ecosystem, "lib/limit.sh");
    if (libContent) {
      fs.mkdirSync(path.join(tmpDir, "lib"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "lib", "limit.sh"), libContent, "utf-8");
      try { fs.chmodSync(path.join(tmpDir, "lib", "limit.sh"), 0o755); } catch (err: unknown) { log.debug(`chmod limit.sh: ${errMsg(err)}`); }
    }

    const coreContent = loadScriptContent(ecosystem, "lib/limit-core.sh");
    if (coreContent) {
      fs.mkdirSync(path.join(tmpDir, "lib"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "lib", "limit-core.sh"), coreContent, "utf-8");
      try { fs.chmodSync(path.join(tmpDir, "lib", "limit-core.sh"), 0o755); } catch (err: unknown) { log.debug(`chmod limit-core.sh: ${errMsg(err)}`); }
    }

    const normContent = loadScriptContent(ecosystem, "architecture/normalize.sh");
    if (normContent) {
      fs.mkdirSync(path.join(tmpDir, "architecture"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "architecture", "normalize.sh"), normContent, "utf-8");
      try { fs.chmodSync(path.join(tmpDir, "architecture", "normalize.sh"), 0o755); } catch (err: unknown) { log.debug(`chmod normalize.sh: ${errMsg(err)}`); }
    }

    const lintCompactContent = loadScriptContent(ecosystem, "lib/lint-compact.sh");
    if (lintCompactContent) {
      fs.mkdirSync(path.join(tmpDir, "lib"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "lib", "lint-compact.sh"), lintCompactContent, "utf-8");
      try { fs.chmodSync(path.join(tmpDir, "lib", "lint-compact.sh"), 0o755); } catch (err: unknown) { log.debug(`chmod lint-compact.sh: ${errMsg(err)}`); }
    }

    const resolveSgContent = loadScriptContent(ecosystem, "lib/resolve-sg.sh");
    if (resolveSgContent) {
      fs.mkdirSync(path.join(tmpDir, "lib"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "lib", "resolve-sg.sh"), resolveSgContent, "utf-8");
      try { fs.chmodSync(path.join(tmpDir, "lib", "resolve-sg.sh"), 0o755); } catch (err: unknown) { log.debug(`chmod resolve-sg.sh: ${errMsg(err)}`); }
    }

    for (const script of selected) {
      const scriptContent = loadScriptContent(ecosystem, script.file);
      if (!scriptContent) {
        results[script.id] = {
          id: script.id,
          status: "error",
          stdout: "",
          stderr: `Script template not found for ecosystem: ${ecosystem}`,
          lines: 0,
        };
        continue;
      }

      const scriptDir = path.join(tmpDir, path.dirname(script.file));
      fs.mkdirSync(scriptDir, { recursive: true });
      const scriptPath = path.join(tmpDir, script.file);
      fs.writeFileSync(scriptPath, scriptContent, "utf-8");
      try { fs.chmodSync(scriptPath, 0o755); } catch (err: unknown) { log.debug(`chmod test script ${scriptPath}: ${errMsg(err)}`); }

      if (script.id === "dead-code") {
        const companions = SCRIPT_COMPANIONS[script.id];
        if (companions) {
          for (const companion of companions) {
            const companionContent = loadScriptContent(ecosystem, companion);
            if (companionContent) {
              const companionDir = path.join(tmpDir, path.dirname(companion));
              fs.mkdirSync(companionDir, { recursive: true });
              const companionPath = path.join(tmpDir, companion);
              fs.writeFileSync(companionPath, companionContent, "utf-8");
              try { fs.chmodSync(companionPath, 0o755); } catch (err: unknown) { log.debug(`chmod companion ${companionPath}: ${errMsg(err)}`); }
            }
          }
        }
      }

      try {
        const { stdout, stderr } = await execFileAsync("bash", [scriptPath], {
          encoding: "utf-8",
          timeout: TEST_RUN_TIMEOUT_MS,
          cwd: process.cwd(),
        });
        const trimmed = stdout.trim();
        const lineCount = trimmed ? trimmed.split("\n").length : 0;
        results[script.id] = {
          id: script.id,
          status: trimmed ? "success" : "empty",
          stdout: trimmed,
          stderr: stderr.trim(),
          lines: lineCount,
        };
      } catch (err: any) {
        const isTimeout = err.killed || (err.message && err.message.includes("timed out"));
        results[script.id] = {
          id: script.id,
          status: isTimeout ? "timeout" : "error",
          stdout: err.stdout?.trim() || "",
          stderr: err.stderr?.trim() || err.message || "Unknown error",
          lines: err.stdout ? err.stdout.trim().split("\n").length : 0,
        };
      }
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err: unknown) { log.debug(`cleanup tmpdir failed: ${errMsg(err)}`); }
  }

  return results;
}

export async function aiValidateScripts(
  agent: AiAgent,
  results: Record<string, RunResult>,
): Promise<string[]> {
  const cliArgs: Record<string, string[] | undefined> = { "Claude Code": ["claude"], "Cursor": ["cursor-agent"], "Aider": ["aider"], "Gemini": ["gemini"], "OpenClaw": ["openclaw"], "Hermes": ["hermes"] };
  const resolved = cliArgs[agent];
  if (!resolved) {
    console.log(chalk.yellow(`  ⚠ No CLI command configured for agent: ${agent}. Skipping AI validation.`));
    return Object.keys(results).filter((id) => results[id].status === "success");
  }

  const summary = Object.entries(results)
    .map(([id, r]) => {
      const preview = r.stdout ? r.stdout.split("\n").slice(0, 3).join(" ") : "(no output)";
      return `[Script: ${id}] Status: ${r.status} | Lines: ${r.lines} | Preview: ${preview}${r.stderr ? ` | Error: ${r.stderr.split("\n")[0]}` : ""}`;
    })
    .join("\n");

  const prompt = `You are configuring PipeMD. I ran the detected context scripts on this codebase. Here are the results:\n\n${summary}\n\nEvaluate the outputs. Discard any scripts that returned errors, empty strings, or unhelpful noise. Return ONLY a JSON array of the script IDs to keep. Example: ["tree","git-log"]`;

  try {
    console.log(chalk.dim(`  Running AI validation with ${agent}...`));
    const { stdout } = await execFileAsync(resolved[0], [...resolved.slice(1), "-p", prompt], {
      encoding: "utf-8",
      timeout: 30000,
      cwd: process.cwd(),
    });

    const jsonMatch = stdout.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed) && parsed.every((s: unknown) => typeof s === "string")) {
          return parsed as string[];
        }
      } catch (err: unknown) { log.debug(`parse AI response failed: ${errMsg(err)}`); }
    }
    console.log(chalk.yellow("  ⚠ Could not parse AI response. Keeping successful scripts only."));
    return Object.keys(results).filter((id) => results[id].status === "success");
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ AI validation failed: ${err.message}. Keeping successful scripts only.`));
    return Object.keys(results).filter((id) => results[id].status === "success");
  }
}
