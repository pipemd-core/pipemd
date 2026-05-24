import fs from "node:fs";
import path from "node:path";
import type { DeliveryMode } from "./injection-types.js";
import type { HookInstallResult } from "./hooks.js";
import { log, errMsg } from "./logger.js";

export interface HookEntry {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
  category: "crew" | "inject" | "statusline";
  injectOnly?: boolean;
}

export interface StatuslineConfig {
  command: string;
  padding?: number;
}

export interface JsonHooksOpts {
  file: string;
  harness: string;
  mechanism: string;
  hooks: HookEntry[];
  delivery: DeliveryMode;
  dryRun: boolean;
  statusline?: StatuslineConfig;
  settingsDir: string;
}

export function hasPmdHookInEvent(hooks: Record<string, unknown>, event: string, needle: string, matcher?: string): boolean {
  const entries = Array.isArray(hooks?.[event]) ? hooks[event] : [];
  for (const entry of entries) {
    if (matcher && (entry as Record<string, unknown>)?.matcher !== matcher) continue;
    for (const h of ((entry as Record<string, unknown>)?.hooks ?? []) as Record<string, unknown>[]) {
      if (typeof h?.command === "string" && (h.command as string).includes(needle)) return true;
    }
  }
  return false;
}

export function hasPmdCrewHookInEvent(hooks: Record<string, unknown>, event: string): boolean {
  return hasPmdHookInEvent(hooks, event, "pmd crew");
}

export function hasPmdInjectHookInEvent(hooks: Record<string, unknown>, event: string, matcher?: string): boolean {
  return hasPmdHookInEvent(hooks, event, "pmd inject", matcher);
}

export function hasPmdStatuslineHookInEvent(hooks: Record<string, unknown>, event: string): boolean {
  return hasPmdHookInEvent(hooks, event, "pmd statusline");
}

export function readJsonSettings(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err: unknown) { log.debug(`readJsonSettings failed for ${file}: ${errMsg(err)}`); return null; }
}

export function writeJsonSettings(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function ensureEventArray(hooks: Record<string, unknown>, event: string): unknown[] {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  return hooks[event] as unknown[];
}

export function stripPmdHooksFromSettings(file: string, harness: string): HookInstallResult {
  const settings = readJsonSettings(file);
  if (!settings || !settings.hooks) {
    return { harness, installed: false, mechanism: "hook", detail: "no hooks to remove" };
  }
  let removed = 0;
  for (const event of Object.keys(settings.hooks as Record<string, unknown>)) {
    const entries = Array.isArray((settings.hooks as Record<string, unknown>)[event]) ? (settings.hooks as Record<string, unknown>)[event] as unknown[] : [];
    (settings.hooks as Record<string, unknown>)[event] = entries.filter((entry: unknown) => {
      const e = entry as Record<string, unknown>;
      if (!e.hooks) return true;
      const before = (e.hooks as unknown[]).length;
      e.hooks = (e.hooks as Record<string, unknown>[]).filter((h: Record<string, unknown>) =>
        !(typeof h?.command === "string" && ((h.command as string).includes("pmd crew") || (h.command as string).includes("pmd inject") || (h.command as string).includes("pmd statusline")))
      );
      removed += before - (e.hooks as unknown[]).length;
      return (e.hooks as unknown[]).length > 0;
    });
    if (((settings.hooks as Record<string, unknown>)[event] as unknown[]).length === 0) delete (settings.hooks as Record<string, unknown>)[event];
  }
  if (Object.keys(settings.hooks as Record<string, unknown>).length === 0) delete settings.hooks;
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

const CATEGORY_NEEDLE: Record<string, string> = {
  crew: "pmd crew",
  inject: "pmd inject",
  statusline: "pmd statusline",
};

export function installJsonHooks(opts: JsonHooksOpts): HookInstallResult {
  const settings = readJsonSettings(opts.file);
  if (settings === null) {
    return {
      harness: opts.harness,
      installed: false,
      mechanism: opts.mechanism,
      detail: `${opts.file} is not valid JSON — skipped (fix it, then re-run)`,
    };
  }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  const added: string[] = [];
  const withInjection = opts.delivery === "active" || opts.delivery === "expert";

  for (const hook of opts.hooks) {
    if (hook.injectOnly && !withInjection) continue;

    const needle = CATEGORY_NEEDLE[hook.category];
    const alreadyExists = hook.category === "inject"
      ? hasPmdInjectHookInEvent(settings.hooks as Record<string, unknown>, hook.event, hook.matcher)
      : hasPmdHookInEvent(settings.hooks as Record<string, unknown>, hook.event, needle, hook.matcher);

    if (alreadyExists) continue;

    const entry: Record<string, unknown> = {};
    if (hook.matcher) entry.matcher = hook.matcher;
    entry.hooks = [{ type: "command", command: hook.command }];
    if (hook.timeout) (entry.hooks as Record<string, unknown>[])[0] = { type: "command", command: hook.command, timeout: hook.timeout };
    ensureEventArray(settings.hooks as Record<string, unknown>, hook.event).push(entry);

    const label = hook.matcher
      ? `${hook.event}(${hook.matcher}:${hook.category})`
      : `${hook.event}(${hook.category})`;
    added.push(label);
  }

  let statuslineNote = "";
  if (opts.statusline) {
    const sl = settings.statusLine as Record<string, unknown> | undefined;
    if (!sl || typeof sl !== "object") {
      settings.statusLine = {
        type: "command",
        command: opts.statusline.command,
        ...(opts.statusline.padding !== undefined ? { padding: opts.statusline.padding } : {}),
      };
      added.push("statusLine");
    } else if (
      typeof sl.command === "string" &&
      sl.command.includes("pmd statusline")
    ) {
      /* already ours */
    } else {
      statuslineNote = " (existing statusline preserved — run 'pmd statusline' to preview)";
    }
  }

  if (added.length === 0) {
    return {
      harness: opts.harness,
      installed: false,
      mechanism: opts.mechanism,
      detail: "already installed" + statuslineNote,
      injectionMode: withInjection ? opts.delivery : undefined,
    };
  }

  if (!opts.dryRun) writeJsonSettings(opts.file, settings);
  return {
    harness: opts.harness,
    installed: !opts.dryRun,
    mechanism: opts.mechanism,
    detail: opts.dryRun
      ? `needs update: ${added.join(" + ")} → ${opts.settingsDir}${statuslineNote}`
      : `${added.join(" + ")} → ${opts.settingsDir}${statuslineNote}`,
    injectionMode: withInjection ? opts.delivery : undefined,
  };
}
