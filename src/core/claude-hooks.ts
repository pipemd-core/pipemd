import path from "node:path";
import type { DeliveryMode } from "./injection-types.js";
import type { HookInstallResult } from "./hooks.js";
import { hasPmdCrewHookInEvent, hasPmdInjectHookInEvent, readJsonSettings, writeJsonSettings, ensureEventArray, stripPmdHooksFromSettings } from "./hook-utils.js";
import { log, errMsg } from "./logger.js";

const CLAUDE_CLAIM_CMD =
  'f=$(jq -r \'.tool_input.file_path // empty\' 2>/dev/null); ' +
  '[ -n "$f" ] && pmd crew claim "$f" >/dev/null 2>&1; true';
const CLAUDE_HEARTBEAT_CMD = "pmd crew heartbeat >/dev/null 2>&1; true";
const CLAUDE_JOIN_CMD = "pmd crew join >/dev/null 2>&1; true";
const CLAUDE_JOIN_WORKER_CMD =
  'SID=$(pmd crew join --role worker 2>/dev/null | grep -oP \'cr_[0-9a-f]+\' | head -1); ' +
  '[ -n "$SID" ] && echo "export PMD_SESSION=$SID" >> "$CLAUDE_PROJECT_DIR/.pipemd/.crew-subagent-env"; true';
const CLAUDE_LEAVE_CMD = "pmd crew leave >/dev/null 2>&1; rm -f \"$CLAUDE_PROJECT_DIR/.pipemd/.crew-subagent-env\"; true";

const CLAUDE_INJECT_BEFORE_READ =
  'pmd inject --trigger before-read --file "$(jq -r \'.tool_input.file_path // .tool_input.pattern // empty\' 2>/dev/null)" --format claude-hook --session "${PMD_SESSION:-}" 2>/dev/null; true';

const CLAUDE_INJECT_BEFORE_EDIT =
  'pmd inject --trigger before-edit --file "$(jq -r \'.tool_input.file_path // .tool_input.path // empty\' 2>/dev/null)" --format claude-hook --session "${PMD_SESSION:-}" 2>/dev/null; true';

const CLAUDE_INJECT_AFTER_EDIT =
  'pmd inject --trigger after-edit --file "$(jq -r \'.tool_input.file_path // .tool_input.path // empty\' 2>/dev/null)" --async-validate --session "${PMD_SESSION:-}" >/dev/null 2>&1; true';

const CLAUDE_INJECT_ON_STOP =
  'pmd inject --trigger on-idle --format claude-hook --session "${PMD_SESSION:-}" 2>/dev/null; true';

const CLAUDE_STATUSLINE_CMD = "pmd statusline --format claude";

export function installClaudeCodeHooks(
  cwd: string = process.cwd(),
  delivery: DeliveryMode = "passive",
  dryRun: boolean = false,
  _force: boolean = false,
): HookInstallResult {
  const file = path.join(cwd, ".claude", "settings.json");
  const settings = readJsonSettings(file);
  if (settings === null) {
    return {
      harness: "Claude Code",
      installed: false,
      mechanism: "hook",
      detail: ".claude/settings.json is not valid JSON — skipped (fix it, then re-run)",
    };
  }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  const added: string[] = [];
  const withInjection = delivery === "active" || delivery === "expert";

  if (!hasPmdCrewHookInEvent(settings.hooks, "SessionStart")) {
    ensureEventArray(settings.hooks, "SessionStart").push({
      hooks: [{ type: "command", command: CLAUDE_JOIN_CMD }],
    });
    added.push("SessionStart");
  }

  if (!hasPmdCrewHookInEvent(settings.hooks, "PreToolUse")) {
    ensureEventArray(settings.hooks, "PreToolUse").push({
      matcher: "Read|ReadFile|Glob|Grep|Bash",
      hooks: [{ type: "command", command: CLAUDE_HEARTBEAT_CMD, timeout: 5 }],
    });
    added.push("PreToolUse(read:heartbeat)");
  }

  if (!hasPmdCrewHookInEvent(settings.hooks, "PostToolUse")) {
    ensureEventArray(settings.hooks, "PostToolUse").push({
      matcher: "Edit|Write|MultiEdit",
      hooks: [{ type: "command", command: CLAUDE_CLAIM_CMD }],
    });
    added.push("PostToolUse(edit:claim)");
  }

  if (!hasPmdCrewHookInEvent(settings.hooks, "SubagentStart")) {
    ensureEventArray(settings.hooks, "SubagentStart").push({
      hooks: [{ type: "command", command: CLAUDE_JOIN_WORKER_CMD }],
    });
    added.push("SubagentStart");
  }

  if (!hasPmdCrewHookInEvent(settings.hooks, "SubagentStop")) {
    ensureEventArray(settings.hooks, "SubagentStop").push({
      hooks: [{ type: "command", command: CLAUDE_LEAVE_CMD }],
    });
    added.push("SubagentStop");
  }

  if (!hasPmdCrewHookInEvent(settings.hooks, "Stop")) {
    ensureEventArray(settings.hooks, "Stop").push({
      hooks: [{ type: "command", command: CLAUDE_HEARTBEAT_CMD }],
    });
    added.push("Stop");
  }

  if (!hasPmdCrewHookInEvent(settings.hooks, "SessionEnd")) {
    ensureEventArray(settings.hooks, "SessionEnd").push({
      hooks: [{ type: "command", command: CLAUDE_LEAVE_CMD }],
    });
    added.push("SessionEnd");
  }

  if (withInjection) {
    const readMatcher = "Read|ReadFile|Glob|Grep";
    if (!hasPmdInjectHookInEvent(settings.hooks, "PreToolUse", readMatcher)) {
      ensureEventArray(settings.hooks, "PreToolUse").push({
        matcher: readMatcher,
        hooks: [{ type: "command", command: CLAUDE_INJECT_BEFORE_READ, timeout: 5 }],
      });
      added.push("PreToolUse(read:inject)");
    }

    const editMatcher = "Edit|Write|MultiEdit";
    if (!hasPmdInjectHookInEvent(settings.hooks, "PreToolUse", editMatcher)) {
      ensureEventArray(settings.hooks, "PreToolUse").push({
        matcher: editMatcher,
        hooks: [{ type: "command", command: CLAUDE_INJECT_BEFORE_EDIT, timeout: 5 }],
      });
      added.push("PreToolUse(edit:inject)");
    }

    if (!hasPmdInjectHookInEvent(settings.hooks, "PostToolUse", editMatcher)) {
      ensureEventArray(settings.hooks, "PostToolUse").push({
        matcher: editMatcher,
        hooks: [{ type: "command", command: CLAUDE_INJECT_AFTER_EDIT, timeout: 5 }],
      });
      added.push("PostToolUse(edit:async-validate)");
    }

    if (!hasPmdInjectHookInEvent(settings.hooks, "Stop")) {
      ensureEventArray(settings.hooks, "Stop").push({
        hooks: [{ type: "command", command: CLAUDE_INJECT_ON_STOP }],
      });
      added.push("Stop(inject:on-idle)");
    }
  }

  let statuslineNote = "";
  if (!settings.statusLine || typeof settings.statusLine !== "object") {
    settings.statusLine = {
      type: "command",
      command: CLAUDE_STATUSLINE_CMD,
      padding: 0,
    };
    added.push("statusLine");
  } else if (
    typeof settings.statusLine.command === "string" &&
    settings.statusLine.command.includes("pmd statusline")
  ) {
    /* already ours — nothing to do */
  } else {
    statuslineNote =
      " (existing statusline preserved — run 'pmd statusline' to preview)";
  }

  if (added.length === 0) {
    return {
      harness: "Claude Code",
      installed: false,
      mechanism: "hook",
      detail: "already installed" + statuslineNote,
      injectionMode: withInjection ? delivery : undefined,
    };
  }

  if (!dryRun) writeJsonSettings(file, settings);
  return {
    harness: "Claude Code",
    installed: !dryRun,
    mechanism: "hook",
    detail: dryRun
      ? `needs update: ${added.join(" + ")} → .claude/settings.json${statuslineNote}`
      : `${added.join(" + ")} → .claude/settings.json${statuslineNote}`,
    injectionMode: withInjection ? delivery : undefined,
  };
}

export function removeClaudeCodeHooks(cwd: string): HookInstallResult {
  const file = path.join(cwd, ".claude", "settings.json");
  const result = stripPmdHooksFromSettings(file, "Claude Code");

  try {
    const settings = readJsonSettings(file);
    if (
      settings &&
      settings.statusLine &&
      typeof settings.statusLine.command === "string" &&
      settings.statusLine.command.includes("pmd statusline")
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
