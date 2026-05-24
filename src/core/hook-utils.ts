import fs from "node:fs";
import path from "node:path";
import type { HookInstallResult } from "./hooks.js";
import { log, errMsg } from "./logger.js";

export function hasPmdHookInEvent(hooks: any, event: string, needle: string, matcher?: string): boolean {
  const entries = Array.isArray(hooks?.[event]) ? hooks[event] : [];
  for (const entry of entries) {
    if (matcher && entry?.matcher !== matcher) continue;
    for (const h of entry?.hooks ?? []) {
      if (typeof h?.command === "string" && h.command.includes(needle)) return true;
    }
  }
  return false;
}

export function hasPmdCrewHookInEvent(hooks: any, event: string): boolean {
  return hasPmdHookInEvent(hooks, event, "pmd crew");
}

export function hasPmdInjectHookInEvent(hooks: any, event: string, matcher?: string): boolean {
  return hasPmdHookInEvent(hooks, event, "pmd inject", matcher);
}

export function hasPmdStatuslineHookInEvent(hooks: any, event: string): boolean {
  return hasPmdHookInEvent(hooks, event, "pmd statusline");
}

export function readJsonSettings(file: string): any | null {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err: unknown) { log.debug(`readJsonSettings failed for ${file}: ${errMsg(err)}`); return null; }
}

export function writeJsonSettings(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function ensureEventArray(hooks: any, event: string): any[] {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  return hooks[event];
}

export function stripPmdHooksFromSettings(file: string, harness: string): HookInstallResult {
  const settings = readJsonSettings(file);
  if (!settings || !settings.hooks) {
    return { harness, installed: false, mechanism: "hook", detail: "no hooks to remove" };
  }
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const entries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = entries.filter((entry: any) => {
      if (!entry?.hooks) return true;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((h: any) =>
        !(typeof h?.command === "string" && (h.command.includes("pmd crew") || h.command.includes("pmd inject") || h.command.includes("pmd statusline")))
      );
      removed += before - entry.hooks.length;
      return entry.hooks.length > 0;
    });
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeJsonSettings(file, settings);
  return {
    harness,
    installed: true,
    mechanism: "hook",
    detail: removed > 0
      ? `removed ${removed} pmd hook(s) from ${file}`
      : "no hooks to remove",
  };
}
