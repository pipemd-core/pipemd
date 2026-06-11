import path from "node:path";
import type { DeliveryMode } from "./injection-types.js";
import type { HookInstallResult, HarnessAdapter } from "./hooks.js";
import { installJsonHooks, readJsonSettings, writeJsonSettings, stripPmdHooksFromSettings } from "./hook-utils.js";
import type { HookEntry } from "./hook-utils.js";
import { log, errMsg } from "./logger.js";

const CREW_HOOKS: HookEntry[] = [
  { event: "SessionStart", command: "pmd crew join >/dev/null 2>&1; true", category: "crew" },
  { event: "PreToolUse", matcher: "Read|ReadFile|Glob|Grep|Bash", command: "pmd crew heartbeat >/dev/null 2>&1; true", timeout: 5, category: "crew" },
  { event: "PostToolUse", matcher: "Edit|Write|MultiEdit", command: 'f=$(jq -r \'.tool_input.file_path // empty\' 2>/dev/null); [ -n "$f" ] && pmd crew claim "$f" >/dev/null 2>&1; true', category: "crew" },
  { event: "SubagentStart", command: 'SID=$(pmd crew join --role worker 2>/dev/null | grep -oP \'cr_[0-9a-f]+\' | head -1); [ -n "$SID" ] && echo "export PMD_SESSION=$SID" >> "$CLAUDE_PROJECT_DIR/.pipemd/.crew-subagent-env"; true', category: "crew" },
  { event: "SubagentStop", command: 'pmd crew leave >/dev/null 2>&1; rm -f "$CLAUDE_PROJECT_DIR/.pipemd/.crew-subagent-env"; true', category: "crew" },
  { event: "Stop", command: "pmd crew heartbeat >/dev/null 2>&1; true", category: "crew" },
  { event: "SessionEnd", command: 'pmd crew leave >/dev/null 2>&1; rm -f "$CLAUDE_PROJECT_DIR/.pipemd/.crew-subagent-env"; true', category: "crew" },
];

const INJECT_HOOKS: HookEntry[] = [
  {
    event: "PreToolUse", matcher: "Read|ReadFile|Glob|Grep", injectOnly: true,
    command: 'pmd inject --trigger before-read --file "$(jq -r \'.tool_input.file_path // .tool_input.pattern // empty\' 2>/dev/null)" --format claude-hook --session "${PMD_SESSION:-}" 2>/dev/null; true',
    timeout: 5, category: "inject",
  },
  {
    event: "PreToolUse", matcher: "Edit|Write|MultiEdit", injectOnly: true,
    command: 'pmd inject --trigger before-edit --file "$(jq -r \'.tool_input.file_path // .tool_input.path // empty\' 2>/dev/null)" --format claude-hook --session "${PMD_SESSION:-}" 2>/dev/null; true',
    timeout: 5, category: "inject",
  },
  {
    event: "PostToolUse", matcher: "Edit|Write|MultiEdit", injectOnly: true,
    command: 'pmd inject --trigger after-edit --file "$(jq -r \'.tool_input.file_path // .tool_input.path // empty\' 2>/dev/null)" --async-validate --format claude-hook --session "${PMD_SESSION:-}" 2>/dev/null; true',
    timeout: 5, category: "inject",
  },
  {
    event: "Stop", injectOnly: true,
    command: 'pmd inject --trigger on-idle --format claude-hook --session "${PMD_SESSION:-}" 2>/dev/null; true',
    category: "inject",
  },
];

const ALL_HOOKS = [...CREW_HOOKS, ...INJECT_HOOKS];

function installClaudeCodeHooks(
  cwd: string = process.cwd(),
  delivery: DeliveryMode = "passive",
  dryRun: boolean = false,
  _force: boolean = false,
): HookInstallResult {
  return installJsonHooks({
    file: path.join(cwd, ".claude", "settings.json"),
    harness: "Claude Code",
    mechanism: "hook",
    hooks: ALL_HOOKS,
    delivery,
    dryRun,
    settingsDir: ".claude/settings.json",
    statusline: { command: "pmd statusline --format claude", padding: 0 },
  });
}

export const claudeAdapter: HarnessAdapter = {
  name: "Claude Code",
  installHooks: installClaudeCodeHooks,
  removeHooks: removeClaudeCodeHooks,
};

function removeClaudeCodeHooks(cwd: string): HookInstallResult {
  const file = path.join(cwd, ".claude", "settings.json");
  const result = stripPmdHooksFromSettings(file, "Claude Code");

  try {
    const settings = readJsonSettings(file);
    if (
      settings &&
      settings.statusLine &&
      typeof (settings.statusLine as Record<string, unknown>).command === "string" &&
      ((settings.statusLine as Record<string, unknown>).command as string).includes("pmd statusline")
    ) {
      delete settings.statusLine;
      writeJsonSettings(file, settings);
      result.installed = true;
      result.detail =
        result.detail === "no hooks to remove"
          ? "removed pmd statusline"
          : `${result.detail} \u00b7 removed pmd statusline`;
    }
  } catch (err: unknown) { log.debug(`removeClaudeCodeHooks statusline cleanup failed: ${errMsg(err)}`); }

  return result;
}
