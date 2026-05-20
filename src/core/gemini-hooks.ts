import path from "node:path";
import type { DeliveryMode } from "./injection-types.js";
import type { HookInstallResult } from "./hooks.js";
import { hasPmdCrewHookInEvent, hasPmdInjectHookInEvent, hasPmdStatuslineHookInEvent, readJsonSettings, writeJsonSettings, ensureEventArray, stripPmdHooksFromSettings } from "./hook-utils.js";

const GEMINI_CLAIM_CMD =
  'f=$(jq -r \'.tool_input.file_path // .tool_args.file_path // ' +
  ".tool_input.absolute_path // .tool_args.absolute_path // .file_path // empty' " +
  '2>/dev/null); [ -n "$f" ] && pmd crew claim "$f" >/dev/null 2>&1; echo \'{}\'';
const GEMINI_HEARTBEAT_CMD = "pmd crew heartbeat >/dev/null 2>&1; echo '{}'";
const GEMINI_JOIN_CMD = "pmd crew join >/dev/null 2>&1; echo '{}'";
const GEMINI_LEAVE_CMD = "pmd crew leave >/dev/null 2>&1; echo '{}'";

const GEMINI_STATUSLINE_CMD = "pmd statusline --format gemini 2>/dev/null; true";

const GEMINI_INJECT_BEFORE_READ =
  'pmd inject --trigger before-read --file "$(jq -r \'.tool_input.file_path // .tool_args.file_path // empty\' 2>/dev/null)" --format gemini-json --session "${PMD_SESSION:-}" 2>/dev/null; true';

const GEMINI_INJECT_BEFORE_EDIT =
  'pmd inject --trigger before-edit --file "$(jq -r \'.tool_input.file_path // .tool_args.file_path // .file_path // empty\' 2>/dev/null)" --format gemini-json --session "${PMD_SESSION:-}" 2>/dev/null; true';

const GEMINI_INJECT_AFTER_EDIT =
  'pmd inject --trigger after-edit --file "$(jq -r \'.tool_input.file_path // .tool_args.file_path // .file_path // empty\' 2>/dev/null)" --async-validate --session "${PMD_SESSION:-}" >/dev/null 2>&1; echo \'{}\'';

export function installGeminiHooks(
  cwd: string = process.cwd(),
  delivery: DeliveryMode = "passive",
  dryRun: boolean = false,
  _force: boolean = false,
): HookInstallResult {
  const file = path.join(cwd, ".gemini", "settings.json");
  const settings = readJsonSettings(file);
  if (settings === null) {
    return {
      harness: "Gemini",
      installed: false,
      mechanism: "hook",
      detail: ".gemini/settings.json is not valid JSON — skipped (fix it, then re-run)",
    };
  }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  const added: string[] = [];
  const withInjection = delivery === "active" || delivery === "expert";

  if (!hasPmdCrewHookInEvent(settings.hooks, "BeforeTool")) {
    ensureEventArray(settings.hooks, "BeforeTool").push({
      matcher: "read_file|cat|search|list_directory",
      hooks: [{ type: "command", command: GEMINI_HEARTBEAT_CMD }],
    });
    added.push("BeforeTool(read:heartbeat)");
  }

  if (!hasPmdCrewHookInEvent(settings.hooks, "AfterTool")) {
    ensureEventArray(settings.hooks, "AfterTool").push({
      matcher: "write_file|replace|edit_file|edit",
      hooks: [{ type: "command", command: GEMINI_CLAIM_CMD }],
    });
    added.push("AfterTool(edit:claim)");
  }

  if (!hasPmdStatuslineHookInEvent(settings.hooks, "SessionStart")) {
    ensureEventArray(settings.hooks, "SessionStart").push({
      matcher: "startup",
      hooks: [{ type: "command", command: GEMINI_STATUSLINE_CMD }],
    });
    added.push("SessionStart(statusline)");
  }

  if (!hasPmdStatuslineHookInEvent(settings.hooks, "AfterAgent")) {
    ensureEventArray(settings.hooks, "AfterAgent").push({
      matcher: "*",
      hooks: [{ type: "command", command: GEMINI_STATUSLINE_CMD }],
    });
    added.push("AfterAgent(statusline)");
  }

  if (withInjection) {
    const readMatcher = "read_file|cat|search|list_directory";
    if (!hasPmdInjectHookInEvent(settings.hooks, "BeforeTool", readMatcher)) {
      ensureEventArray(settings.hooks, "BeforeTool").push({
        matcher: readMatcher,
        hooks: [{ type: "command", command: GEMINI_INJECT_BEFORE_READ }],
      });
      added.push("BeforeTool(read:inject)");
    }

    const editMatcher = "write_file|replace|edit_file|edit";
    if (!hasPmdInjectHookInEvent(settings.hooks, "BeforeTool", editMatcher)) {
      ensureEventArray(settings.hooks, "BeforeTool").push({
        matcher: editMatcher,
        hooks: [{ type: "command", command: GEMINI_INJECT_BEFORE_EDIT }],
      });
      added.push("BeforeTool(edit:inject)");
    }

    if (!hasPmdInjectHookInEvent(settings.hooks, "AfterTool", editMatcher)) {
      ensureEventArray(settings.hooks, "AfterTool").push({
        matcher: editMatcher,
        hooks: [{ type: "command", command: GEMINI_INJECT_AFTER_EDIT }],
      });
      added.push("AfterTool(edit:async-validate)");
    }
  }

  if (added.length === 0) {
    return {
      harness: "Gemini",
      installed: false,
      mechanism: "hook",
      detail: "already installed",
      injectionMode: withInjection ? delivery : undefined,
    };
  }

  if (!dryRun) writeJsonSettings(file, settings);
  return {
    harness: "Gemini",
    installed: !dryRun,
    mechanism: "hook",
    detail: dryRun
      ? `needs update: ${added.join(" + ")} → .gemini/settings.json (Golden-Rule compliant)`
      : `${added.join(" + ")} → .gemini/settings.json (Golden-Rule compliant)`,
    injectionMode: withInjection ? delivery : undefined,
  };
}

export function removeGeminiHooks(cwd: string): HookInstallResult {
  return stripPmdHooksFromSettings(
    path.join(cwd, ".gemini", "settings.json"),
    "Gemini",
  );
}
