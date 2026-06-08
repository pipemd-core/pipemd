import type { DeliveryMode } from "./injection-types.js";
import { claudeAdapter } from "./claude-hooks.js";
import { geminiAdapter } from "./gemini-hooks.js";
import { opencodeAdapter } from "./opencode-hooks.js";
import { errMsg } from "./logger.js";

export interface HookInstallResult {
  harness: string;
  installed: boolean;
  mechanism: string;
  detail: string;
  injectionMode?: DeliveryMode;
}

export interface HarnessAdapter {
  name: string;
  installHooks(cwd: string, delivery: DeliveryMode, dryRun: boolean, force: boolean): HookInstallResult;
  removeHooks(cwd: string): HookInstallResult;
}

const adapters: Map<string, HarnessAdapter> = new Map([
  ["Claude Code", claudeAdapter],
  ["OpenCode", opencodeAdapter],
  ["Gemini", geminiAdapter],
]);

export function registerAdapter(adapter: HarnessAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): HarnessAdapter | undefined {
  return adapters.get(name);
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
    const adapter = adapters.get(harness);
    if (adapter) {
      return adapter.installHooks(cwd, delivery, dryRun, force);
    }
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
    const adapter = adapters.get(harness);
    if (adapter) return adapter.removeHooks(cwd);
    return { harness, installed: false, mechanism: "none", detail: "no hooks to remove" };
  } catch (err: unknown) {
    const msg = errMsg(err);
    return { harness, installed: false, mechanism: "error", detail: msg };
  }
}
