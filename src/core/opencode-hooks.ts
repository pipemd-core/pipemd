import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DeliveryMode } from "./injection-types.js";
import type { HookInstallResult, HarnessAdapter } from "./hooks.js";
import { log, errMsg } from "./logger.js";

declare const PKG_VERSION: string;

const OPENCODE_PLUGIN_VERSION = (() => {
  const numeric = PKG_VERSION.split(".")[0] || "1";
  const minor = PKG_VERSION.split(".")[1] || "0";
  return (Number(numeric) || 1) * 100 + (Number(minor) || 0);
})();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(__dirname, "..", "plugins");

function loadTemplate(name: string): string {
  return fs.readFileSync(path.join(PLUGIN_DIR, name), "utf-8");
}

function stampVersion(template: string): string {
  return template.replace(/\$\{PLUGIN_VERSION\}/g, () => String(OPENCODE_PLUGIN_VERSION));
}

function buildPluginConfig(delivery: DeliveryMode): string {
  return JSON.stringify({ delivery, version: OPENCODE_PLUGIN_VERSION }, null, 2) + "\n";
}

export function installOpenCodeHooks(
  cwd: string = process.cwd(),
  delivery: DeliveryMode = "passive",
  dryRun: boolean = false,
  force: boolean = false,
): HookInstallResult {
  const dir = path.join(cwd, ".opencode", "plugin");
  const serverFile = path.join(dir, "pmd-crew.js");
  const configFile = path.join(dir, "pmd-config.json");
  const tuiFile = path.join(cwd, ".opencode", "pmd-crew-tui.js");
  const legacyTuiFile = path.join(dir, "pmd-crew-tui.js");
  const tuiConfigFile = path.join(cwd, ".opencode", "tui.json");

  const plugin = stampVersion(loadTemplate("opencode-server.js"));
  const tuiPlugin = stampVersion(loadTemplate("opencode-tui.js"));
  const config = buildPluginConfig(delivery);
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

  if (!dryRun && serverInstalled) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configFile, config, "utf-8");
      results.push("config: written");
    } catch (err: unknown) { log.debug(`write config failed: ${errMsg(err)}`); }
  }

  if (!dryRun && fs.existsSync(legacyTuiFile)) {
    try { fs.unlinkSync(legacyTuiFile); results.push("TUI: removed legacy plugin/ copy"); } catch (err: unknown) { log.debug(`unlink legacy TUI failed: ${errMsg(err)}`); }
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
    } catch (err: unknown) {
      log.debug(`tui.json parse failed, recreating: ${errMsg(err)}`);
      configUpdated = true;
      if (!dryRun) fs.writeFileSync(tuiConfigFile, JSON.stringify({ plugin: [relPath] }, null, 2) + "\n", "utf-8");
      results.push("tui.json: created");
    }
  } else {
    configUpdated = true;
    if (!dryRun) {
      fs.mkdirSync(path.dirname(tuiConfigFile), { recursive: true });
      fs.writeFileSync(tuiConfigFile, JSON.stringify({ plugin: [relPath] }, null, 2) + "\n", "utf-8");
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
    injectionMode: delivery === "active" || delivery === "expert" ? delivery : undefined,
  };
}

export const opencodeAdapter: HarnessAdapter = {
  name: "OpenCode",
  installHooks: installOpenCodeHooks,
  removeHooks: removeOpenCodeHooks,
};

export function removeOpenCodeHooks(cwd: string): HookInstallResult {
  const results: string[] = [];
  let removed = false;
  const serverFile = path.join(cwd, ".opencode", "plugin", "pmd-crew.js");
  const configFile = path.join(cwd, ".opencode", "plugin", "pmd-config.json");
  const tuiFile = path.join(cwd, ".opencode", "pmd-crew-tui.js");
  const legacyTuiFile = path.join(cwd, ".opencode", "plugin", "pmd-crew-tui.js");
  const tuiConfigFile = path.join(cwd, ".opencode", "tui.json");

  try { fs.unlinkSync(serverFile); results.push("server plugin removed"); removed = true; } catch (err: unknown) { log.debug(`unlink server failed: ${errMsg(err)}`); }
  try { fs.unlinkSync(configFile); results.push("config removed"); } catch (err: unknown) { log.debug(`unlink config failed: ${errMsg(err)}`); }
  try { fs.unlinkSync(tuiFile); results.push("TUI plugin removed"); removed = true; } catch (err: unknown) { log.debug(`unlink TUI failed: ${errMsg(err)}`); }
  try { fs.unlinkSync(legacyTuiFile); results.push("legacy TUI plugin removed"); removed = true; } catch (err: unknown) { log.debug(`unlink legacy TUI failed: ${errMsg(err)}`); }

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
    } catch (err: unknown) { log.debug(`tui.json cleanup parse failed: ${errMsg(err)}`); }
  }

  return {
    harness: "OpenCode",
    installed: removed,
    mechanism: "plugin",
    detail: results.length ? results.join(" \u00b7 ") : "nothing to remove",
  };
}
