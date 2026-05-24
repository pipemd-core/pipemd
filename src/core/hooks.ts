import type { DeliveryMode } from "./injection-types.js";
import { installClaudeCodeHooks, removeClaudeCodeHooks } from "./claude-hooks.js";
import { installGeminiHooks, removeGeminiHooks } from "./gemini-hooks.js";
import { installOpenCodeHooks, removeOpenCodeHooks } from "./opencode-hooks.js";
import { errMsg } from "./logger.js";

export interface HookInstallResult {
  harness: string;
  installed: boolean;
  mechanism: string;
  detail: string;
  injectionMode?: DeliveryMode;
}

const INSTRUCTION_ONLY = ["Cursor", "Aider", "OpenClaw", "Hermes", "OS Agent"];

export function installHooks(
  harness: string,
  cwd: string = process.cwd(),
  delivery: DeliveryMode = "passive",
  dryRun: boolean = false,
  force: boolean = false,
): HookInstallResult {
  try {
    if (harness === "Claude Code") return installClaudeCodeHooks(cwd, delivery, dryRun, force);
    if (harness === "OpenCode") return installOpenCodeHooks(cwd, delivery, dryRun, force);
    if (harness === "Gemini") return installGeminiHooks(cwd, delivery, dryRun, force);
    if (INSTRUCTION_ONLY.includes(harness)) {
      return {
        harness,
        installed: false,
        mechanism: "instruction",
        detail: "no edit-event API — uses the injected Coordination Protocol",
      };
    }
    return { harness, installed: false, mechanism: "unknown", detail: "unrecognized harness" };
  } catch (err: unknown) {
    const msg = errMsg(err);
    return { harness, installed: false, mechanism: "error", detail: msg };
  }
}

export function removeHooks(harness: string, cwd: string = process.cwd()): HookInstallResult {
  try {
    if (harness === "Claude Code") return removeClaudeCodeHooks(cwd);
    if (harness === "OpenCode") return removeOpenCodeHooks(cwd);
    if (harness === "Gemini") return removeGeminiHooks(cwd);
    return { harness, installed: false, mechanism: "none", detail: "no hooks to remove" };
  } catch (err: unknown) {
    const msg = errMsg(err);
    return { harness, installed: false, mechanism: "error", detail: msg };
  }
}
