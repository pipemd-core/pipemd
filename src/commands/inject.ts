import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { Command } from "commander";
import { resolveInjections, triggerAsyncValidation, buildPostEditFeedback } from "../core/injection-engine.js";
import { loadInjectionConfig } from "../core/injection-types.js";
import type { InjectionTrigger } from "../core/injection-types.js";
import { isPipemdProject, PIPEMD_DIR } from "../core/crew.js";
import { bumpInjectStats } from "../core/statusline-data.js";
import { invalidateCachePattern } from "../core/cache.js";
import { log, errMsg } from "../core/logger.js";


const VALID_TRIGGERS: InjectionTrigger[] = ["before-read", "before-edit", "after-edit", "on-idle", "on-start"];
type InjectFormat = "plain" | "claude-hook" | "gemini-json";

const inject = new Command("inject")
  .description("Resolve and output smart context injection payloads (called by harness hooks)")
  .configureHelp({ visibleCommands: () => [] })
  .option("--trigger <trigger>", `injection trigger: ${VALID_TRIGGERS.join(" | ")}`)
  .option("--file <path>", "target file being read or edited")
  .option("--session <id>", "crew session ID for dedup tracking")
  .option("--async-validate", "spawn background validation after edit, return immediately")
  .option("--run-validation", "internal: execute validation synchronously (called by self-spawn)")
  .option("--invalidate <file>", "invalidate cached quality data for a file (called after edits)")
  .option("--format <format>", "output format: plain | claude-hook | gemini-json")
  .option("--show-last", "output the most recent injection payload without re-running")
  .option("--verbose", "log resolver trace to stderr")
  .action(async (opts: {
    trigger?: string;
    file?: string;
    session?: string;
    asyncValidate?: boolean;
    runValidation?: boolean;
    invalidate?: string;
    format?: string;
    showLast?: boolean;
    verbose?: boolean;
  }) => {
    if (!isPipemdProject()) return;

    if (opts.file) {
      let realPath: string;
      let realCwd: string;
      try {
        realPath = realpathSync(path.resolve(opts.file));
      } catch {
        return;
      }
      try {
        realCwd = realpathSync(process.cwd());
      } catch {
        return;
      }
      if (!realPath.startsWith(realCwd + path.sep) && realPath !== realCwd) {
        return;
      }
    }

    if (opts.showLast) {
      const lastPath = path.join(PIPEMD_DIR, ".injection-log", "last.txt");
      if (existsSync(lastPath)) {
        process.stdout.write(readFileSync(lastPath, "utf-8"));
      }
      return;
    }

    const config = loadInjectionConfig();
    if (config.delivery === "passive") return;

    const trigger = opts.trigger as InjectionTrigger | undefined;
    if (!trigger || !VALID_TRIGGERS.includes(trigger)) return;

    const format: InjectFormat =
      opts.format === "claude-hook" ? "claude-hook"
      : opts.format === "gemini-json" ? "gemini-json"
      : "plain";

    if (opts.runValidation && opts.file) {
      await triggerAsyncValidation(opts.file);
      return;
    }

    if (opts.asyncValidate && opts.file) {
      const self = process.argv[1];
      const args = [
        "inject",
        "--trigger", trigger,
        "--file", opts.file,
        "--run-validation",
      ];
      if (opts.session) {
        args.push("--session", opts.session);
      }
      const child = spawn(process.execPath, [self, ...args], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();

      if (format === "claude-hook" && trigger === "after-edit") {
        const feedback = await buildPostEditFeedback(opts.file);
        if (feedback) {
          const obj = {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: feedback,
            },
          };
          process.stdout.write(JSON.stringify(obj) + "\n");
        } else {
          process.stdout.write("{}\n");
        }
      }
      return;
    }

    if (opts.invalidate) {
      const file = opts.invalidate;
      const patterns = [file.replace(/\//g, "%2F"), "syntax-check%2F", "edit-diff%2F"];
      for (const pat of patterns) {
        invalidateCachePattern(pat);
      }
      return;
    }

    const payloads = await resolveInjections(trigger, opts.file, opts.session, opts.verbose);

    // Record injection traffic so the Claude Code statusline has data — its
    // inject hooks call `pmd inject` directly and would otherwise track nothing.
    // Empty payloads mean a dedup hit (same convention as the OpenCode plugin).
    if (payloads.length === 0) {
      bumpInjectStats(PIPEMD_DIR, "dedup", { trigger, file: opts.file ?? "" });
      if (format === "gemini-json") {
        process.stdout.write("{}\n");
      }
      return;
    }

    bumpInjectStats(PIPEMD_DIR, "delivered", { trigger, file: opts.file ?? "" });

    const parts = payloads.map((p) => {
      const header = p.targetFile
        ? `[pmd:${p.source} \u2192 ${p.targetFile}]`
        : `[pmd:${p.source}]`;
      if (trigger === "before-edit" && p.targetFile) {
        return `${header}\nFile: ${p.targetFile}\n${"---"}\n${p.content}`;
      }
      return `${header}\n${p.content}`;
    });

    const plain = parts.join("\n\n") + "\n";

    const logDir = path.join(PIPEMD_DIR, ".injection-log");
    try {
      mkdirSync(logDir, { recursive: true });
      writeFileSync(path.join(logDir, "last.txt"), plain, "utf-8");
    } catch (err: unknown) { log.debug(`write injection log failed: ${errMsg(err)}`); }

    if (format === "claude-hook") {
      const isStop = trigger === "on-idle" || trigger === "on-start";
      if (isStop) {
        process.stdout.write("{}\n");
      } else {
        const hookEventName = trigger === "before-read" || trigger === "before-edit"
          ? "PreToolUse"
          : "PostToolUse";
        const obj = {
          hookSpecificOutput: {
            hookEventName,
            additionalContext: plain,
          },
        };
        process.stdout.write(JSON.stringify(obj) + "\n");
      }
    } else if (format === "gemini-json") {
      const obj = { context: plain };
      process.stdout.write(JSON.stringify(obj) + "\n");
    } else {
      process.stdout.write(plain);
    }
  });

export const injectCommand = inject;
