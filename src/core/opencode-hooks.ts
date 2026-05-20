import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DeliveryMode } from "./injection-types.js";
import type { HookInstallResult } from "./hooks.js";

const OPENCODE_PLUGIN_VERSION = 14;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(__dirname, "plugins");

function loadTemplate(name: string): string {
  return fs.readFileSync(path.join(PLUGIN_DIR, name), "utf-8");
}

function buildOpenCodePlugin(withInjection: boolean): string {
  const template = loadTemplate("opencode-server.js");

  const deliveryMode = withInjection ? "active" : "passive";

  const injectionHelpers = withInjection
    ? `
let lastInjection = null;
let stableInjected = false;
const INJECT_LOG_DIR = joinPath(".pipemd", ".injection-log");
let injectLogCounter = 0;

function formatTok(n) {
  if (n < 1000) return n + " tok";
  return (n / 1000).toFixed(1).replace(/\\.0$/, "") + "k tok";
}

function storePayload(trigger, payload) {
  try {
    mkdirSync(INJECT_LOG_DIR, { recursive: true });
    injectLogCounter++;
    const sid = getActiveCrewSession();
    const meta = "[pmd-meta session=" + (sid || "") + " trigger=" + (trigger || "") + "]\\n";
    const filename = injectLogCounter + ".txt";
    writeFileSync(joinPath(INJECT_LOG_DIR, filename), meta + payload, "utf-8");
    writeFileSync(joinPath(INJECT_LOG_DIR, "last.txt"), meta + payload, "utf-8");
    stats.lastPayloadFile = filename;
  } catch {}
}
`
    : "";

  const beforeHandler = withInjection
    ? `"tool.execute.before": async (input, output) => {
      try {
        const tool = (input && input.tool) || "";
        const args = (output && output.args) || {};
        const trigger = isEditTool(tool) ? "before-edit" : "before-read";
        const filePath = extractFilePath(args);
        join(); heartbeat();
        const sid = getActiveCrewSession();
        try {
          const out = execFileSync(getPmdBin(), ["inject", "--trigger", trigger, "--file", filePath, "--session", sid], { encoding: "utf-8", timeout: 5000 });
          if (out.trim()) {
            lastInjection = { payload: out.trim(), bytes: out.length, trigger, tool, file: filePath, ts: Date.now() };
            stats.injectionsDelivered++;
            storePayload(trigger, out.trim());
            pushEvent(trigger, tool, filePath, "injected", out.length);
          } else {
            lastInjection = null;
            stats.dedupHits++;
            pushEvent(trigger, tool, filePath, "dedup", 0);
          }
        } catch (e) { lastInjection = null; logPluginError("tool.execute.before", e); pushEvent(trigger, tool, filePath, "ok", 0); }
      } catch (e) { logPluginError("tool.execute.before", e); }
    },`
    : `"tool.execute.before": async (input, output) => {
      try {
        const tool = (input && input.tool) || "";
        const args = (output && output.args) || {};
        join(); heartbeat();
        pushEvent("before", tool, extractFilePath(args), "ok", 0);
      } catch (e) { logPluginError("tool.execute.before", e); }
    },`;

  const afterHandler = withInjection
    ? `"tool.execute.after": async (input, output) => {
      try {
        const tool = (input && input.tool) || "";
        const isEdit = isEditTool(tool);
        if (isEdit) {
          const args = (output && output.args) || (input && input.args) || {};
          const filePath = extractFilePath(args);
          claim(filePath);
          const sid = getActiveCrewSession();
          try {
            execFileSync(getPmdBin(), ["inject", "--trigger", "after-edit", "--file", extractFilePath(args), "--async-validate", "--session", sid], { encoding: "utf-8", timeout: 3000, stdio: "ignore" });
          } catch {}
          pushEvent("after-edit", tool, filePath || "", "claimed", 0);
        }
        if (lastInjection) {
          const inj = lastInjection;
          lastInjection = null;
          const tok = Math.round(inj.bytes / 4);
          if (typeof (output && output.output) === "string") {
            output.output += "\\n" + "[PipeMD] +" + formatTok(tok) + " injected";
          }
        }
      } catch (e) { logPluginError("tool.execute.after", e); }
    },`
    : `"tool.execute.after": async (input, output) => {
      try {
        const tool = (input && input.tool) || "";
        if (!isEditTool(tool)) return;
        const args = (output && output.args) || (input && input.args) || {};
        const filePath = extractFilePath(args);
        claim(filePath);
        pushEvent("after-edit", tool, filePath || "", "claimed", 0);
      } catch (e) { logPluginError("tool.execute.after", e); }
    },`;

  const systemTransform = withInjection
    ? `"experimental.chat.system.transform": async (input, output) => {
      try {
        handleSessionSwitch(input && input.sessionID);
        const sid = getActiveCrewSession();
        if (!stableInjected) {
          try {
            const stable = execFileSync(getPmdBin(), ["inject", "--trigger", "on-start", "--session", sid], { encoding: "utf-8", timeout: 5000 });
            const stableTrimmed = (stable || "").trim();
            if (stableTrimmed) {
              stats.injectionsDelivered++;
              storePayload("on-start", stableTrimmed);
              pushEvent("on-start", "", "", "injected", stable.length);
              output.system.push(stableTrimmed);
            }
          } catch (e) { logPluginError("on-start", e); }
          stableInjected = true;
        }
        const out = execFileSync(getPmdBin(), ["inject", "--trigger", "on-idle", "--session", sid], { encoding: "utf-8", timeout: 5000 });
        const trimmed = (out || "").trim();
        if (trimmed) {
          stats.injectionsDelivered++;
          storePayload("system-transform", trimmed);
          pushEvent("system-transform", "", "", "injected", out.length);
          output.system.push(trimmed);
        }
      } catch (e) { logPluginError("system.transform", e); }
    },`
    : "";

  const eventHandler = `"event": async ({ event }) => {
    try {
      if (!event) return;
      const eventType = event.type;
      const props = event.properties || {};
      if (eventType === "session.idle") {
        const ocSid = props.sessionID;
        if (ocSid && workerSessions.has(ocSid)) {
          leaveWorker(ocSid);
        } else {
          heartbeat();
        }
        pushEvent("on-idle", "", "", "heartbeat", 0);
      } else if (eventType === "session.status" && props.status && props.status.type === "idle") {
        const ocSid = props.sessionID;
        if (ocSid && workerSessions.has(ocSid)) {
          leaveWorker(ocSid);
        }
      }
    } catch (e) { logPluginError("event", e); }
  },`;

  return template
    .replace(/\$\{PLUGIN_VERSION\}/g, String(OPENCODE_PLUGIN_VERSION))
    .replace(/\$\{DELIVERY_MODE\}/g, deliveryMode)
    .replace(/\$\{INJECTION_HELPERS\}/g, injectionHelpers)
    .replace(/\$\{BEFORE_HANDLER\}/g, beforeHandler)
    .replace(/\$\{AFTER_HANDLER\}/g, afterHandler)
    .replace(/\$\{SYSTEM_TRANSFORM\}/g, systemTransform)
    .replace(/\$\{EVENT_HANDLER\}/g, eventHandler);
}

function buildOpenCodeTuiPlugin(): string {
  const template = loadTemplate("opencode-tui.js");
  return template.replace(/\$\{PLUGIN_VERSION\}/g, String(OPENCODE_PLUGIN_VERSION));
}

function buildOpenCodeTuiConfig(pluginRelPath: string): string {
  return JSON.stringify({ plugin: [pluginRelPath] }, null, 2) + "\n";
}

export function installOpenCodeHooks(
  cwd: string = process.cwd(),
  delivery: DeliveryMode = "passive",
  dryRun: boolean = false,
  force: boolean = false,
): HookInstallResult {
  const dir = path.join(cwd, ".opencode", "plugin");
  const serverFile = path.join(dir, "pmd-crew.js");
  const tuiFile = path.join(cwd, ".opencode", "pmd-crew-tui.js");
  const legacyTuiFile = path.join(dir, "pmd-crew-tui.js");
  const tuiConfigFile = path.join(cwd, ".opencode", "tui.json");
  const withInjection = delivery === "active" || delivery === "expert";
  const plugin = buildOpenCodePlugin(withInjection);
  const tuiPlugin = buildOpenCodeTuiPlugin();
  const versionTag = `@pmd-plugin-version ${OPENCODE_PLUGIN_VERSION}`;
  const results: string[] = [];

  let serverInstalled = false;
  if (fs.existsSync(serverFile)) {
    const existing = fs.readFileSync(serverFile, "utf-8");
    if (!force && existing === plugin) {
      results.push("server: already installed");
    } else {
      serverInstalled = true;
      if (!dryRun) fs.writeFileSync(serverFile, plugin, "utf-8");
      results.push(existing.includes(versionTag) ? "server: updated (delivery mode changed)" : "server: updated");
    }
  } else {
    serverInstalled = true;
    if (!dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(serverFile, plugin, "utf-8");
    }
    results.push("server: installed");
  }

  if (!dryRun && fs.existsSync(legacyTuiFile)) {
    try { fs.unlinkSync(legacyTuiFile); results.push("TUI: removed legacy plugin/ copy"); } catch { /* ignore */ }
  }
  let tuiInstalled = false;
  const tuiExisting = fs.existsSync(tuiFile) ? fs.readFileSync(tuiFile, "utf-8") : "";
  if (!force && tuiExisting === tuiPlugin) {
    results.push("TUI: already installed");
  } else {
    tuiInstalled = true;
    if (!dryRun) {
      fs.mkdirSync(path.dirname(tuiFile), { recursive: true });
      fs.writeFileSync(tuiFile, tuiPlugin, "utf-8");
    }
    results.push(tuiExisting.includes(versionTag) ? "TUI: updated" : "TUI: installed");
  }

  let configUpdated = false;
  const relPath = "./pmd-crew-tui.js";
  const legacyRelPath = "./plugin/pmd-crew-tui.js";
  if (fs.existsSync(tuiConfigFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(tuiConfigFile, "utf-8"));
      if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
      const hadLegacy = cfg.plugin.includes(legacyRelPath);
      if (hadLegacy) cfg.plugin = cfg.plugin.filter((p: string) => p !== legacyRelPath);
      if (!cfg.plugin.includes(relPath)) {
        cfg.plugin.push(relPath);
        configUpdated = true;
        if (!dryRun) fs.writeFileSync(tuiConfigFile, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
        results.push(hadLegacy ? "tui.json: migrated entry" : "tui.json: updated");
      } else if (hadLegacy) {
        configUpdated = true;
        if (!dryRun) fs.writeFileSync(tuiConfigFile, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
        results.push("tui.json: dropped legacy entry");
      } else {
        results.push("tui.json: already registered");
      }
    } catch {
      configUpdated = true;
      if (!dryRun) fs.writeFileSync(tuiConfigFile, buildOpenCodeTuiConfig(relPath), "utf-8");
      results.push("tui.json: created");
    }
  } else {
    configUpdated = true;
    if (!dryRun) {
      fs.mkdirSync(path.dirname(tuiConfigFile), { recursive: true });
      fs.writeFileSync(tuiConfigFile, buildOpenCodeTuiConfig(relPath), "utf-8");
    }
    results.push("tui.json: created");
  }

  const anyInstalled = serverInstalled || tuiInstalled || configUpdated;
  const prefix = dryRun && anyInstalled ? "needs update: " : "";
  return {
    harness: "OpenCode",
    installed: !dryRun && anyInstalled,
    mechanism: "plugin",
    detail: prefix + results.join(" \u00b7 "),
    injectionMode: withInjection ? delivery : undefined,
  };
}

export function removeOpenCodeHooks(cwd: string): HookInstallResult {
  const results: string[] = [];
  let removed = false;
  const serverFile = path.join(cwd, ".opencode", "plugin", "pmd-crew.js");
  const tuiFile = path.join(cwd, ".opencode", "pmd-crew-tui.js");
  const legacyTuiFile = path.join(cwd, ".opencode", "plugin", "pmd-crew-tui.js");
  const tuiConfigFile = path.join(cwd, ".opencode", "tui.json");

  try { fs.unlinkSync(serverFile); results.push("server plugin removed"); removed = true; } catch { /* already gone */ }
  try { fs.unlinkSync(tuiFile); results.push("TUI plugin removed"); removed = true; } catch { /* already gone */ }
  try { fs.unlinkSync(legacyTuiFile); results.push("legacy TUI plugin removed"); removed = true; } catch { /* already gone */ }

  if (fs.existsSync(tuiConfigFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(tuiConfigFile, "utf-8"));
      if (Array.isArray(cfg.plugin)) {
        const before = cfg.plugin.length;
        cfg.plugin = cfg.plugin.filter((p: string) => !p.includes("pmd-crew-tui"));
        if (cfg.plugin.length < before) {
          removed = true;
          if (cfg.plugin.length === 0) {
            fs.unlinkSync(tuiConfigFile);
            results.push("tui.json removed (empty)");
          } else {
            fs.writeFileSync(tuiConfigFile, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
            results.push("tui.json updated");
          }
        }
      }
    } catch { /* not valid json — leave alone */ }
  }

  return {
    harness: "OpenCode",
    installed: removed,
    mechanism: "plugin",
    detail: results.length ? results.join(" \u00b7 ") : "nothing to remove",
  };
}
