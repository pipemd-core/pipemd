import path from "node:path";
import type { DeliveryMode } from "./injection-types.js";
import type { HookInstallResult, HarnessAdapter } from "./hooks.js";
import { installJsonHooks, stripPmdHooksFromSettings } from "./hook-utils.js";
import type { HookEntry } from "./hook-utils.js";

const CREW_HOOKS: HookEntry[] = [
  { event: "BeforeTool", matcher: "read_file|cat|search|list_directory", command: "pmd crew heartbeat >/dev/null 2>&1; echo '{}'", category: "crew" },
  { event: "AfterTool", matcher: "write_file|replace|edit_file|edit", command: 'f=$(jq -r \'.tool_input.file_path // .tool_args.file_path // .tool_input.absolute_path // .tool_args.absolute_path // .file_path // empty\' 2>/dev/null); [ -n "$f" ] && pmd crew claim "$f" >/dev/null 2>&1; echo \'{}\'', category: "crew" },
  { event: "SessionStart", matcher: "startup", command: "pmd statusline --format gemini 2>/dev/null; true", category: "statusline" },
  { event: "AfterAgent", matcher: "*", command: "pmd statusline --format gemini 2>/dev/null; true", category: "statusline" },
];

const INJECT_HOOKS: HookEntry[] = [
  {
    event: "BeforeTool", matcher: "read_file|cat|search|list_directory", injectOnly: true,
    command: 'pmd inject --trigger before-read --file "$(jq -r \'.tool_input.file_path // .tool_args.file_path // empty\' 2>/dev/null)" --format gemini-json --session "${PMD_SESSION:-}" 2>/dev/null; true',
    category: "inject",
  },
  {
    event: "BeforeTool", matcher: "write_file|replace|edit_file|edit", injectOnly: true,
    command: 'pmd inject --trigger before-edit --file "$(jq -r \'.tool_input.file_path // .tool_args.file_path // .file_path // empty\' 2>/dev/null)" --format gemini-json --session "${PMD_SESSION:-}" 2>/dev/null; true',
    category: "inject",
  },
  {
    event: "AfterTool", matcher: "write_file|replace|edit_file|edit", injectOnly: true,
    command: 'pmd inject --trigger after-edit --file "$(jq -r \'.tool_input.file_path // .tool_args.file_path // .file_path // empty\' 2>/dev/null)" --async-validate --session "${PMD_SESSION:-}" >/dev/null 2>&1; echo \'{}\'',
    category: "inject",
  },
];

const ALL_HOOKS = [...CREW_HOOKS, ...INJECT_HOOKS];

function installGeminiHooks(
  cwd: string = process.cwd(),
  delivery: DeliveryMode = "passive",
  dryRun: boolean = false,
  _force: boolean = false,
): HookInstallResult {
  return installJsonHooks({
    file: path.join(cwd, ".gemini", "settings.json"),
    harness: "Gemini",
    mechanism: "hook",
    hooks: ALL_HOOKS,
    delivery,
    dryRun,
    settingsDir: ".gemini/settings.json",
  });
}

export const geminiAdapter: HarnessAdapter = {
  name: "Gemini",
  installHooks: installGeminiHooks,
  removeHooks: removeGeminiHooks,
};

function removeGeminiHooks(cwd: string): HookInstallResult {
  return stripPmdHooksFromSettings(
    path.join(cwd, ".gemini", "settings.json"),
    "Gemini",
  );
}
