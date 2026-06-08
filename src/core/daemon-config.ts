import fs from "node:fs";
import YAML from "yaml";
import { DEFAULT_RESERVE_DELAY_MS } from "../config.js";
import type { PipeConfig } from "../config.js";
import { CONFIG_PATH } from "./paths.js";
import { log, errMsg } from "./logger.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

export function validateConfig(raw: unknown): PipeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const msg = "Invalid config.yml: expected a mapping (object), got " + (raw === null ? "null" : typeof raw)
    log.error(msg)
    throw new ConfigError(msg)
  }

  const cfg = raw as Record<string, unknown>;

  if (!cfg.commands || typeof cfg.commands !== "object" || Array.isArray(cfg.commands)) {
    if (cfg.commands === undefined || cfg.commands === null) {
      const msg = "Invalid config.yml: missing 'commands' — nothing to render. Run `pmd init` to regenerate."
      log.error(msg)
      throw new ConfigError(msg)
    }
    const msg = "Invalid config.yml: 'commands' must be a mapping of name → shell command"
    log.error(msg)
    throw new ConfigError(msg)
  }

  if (cfg.pipes !== undefined && cfg.pipes !== null) {
    if (!Array.isArray(cfg.pipes)) {
      const msg = "Invalid config.yml: 'pipes' must be an array"
      log.error(msg)
      throw new ConfigError(msg)
    }
  } else {
    cfg.pipes = [];
  }

  if (cfg.injected !== undefined && cfg.injected !== null) {
    if (!Array.isArray(cfg.injected)) {
      const msg = "Invalid config.yml: 'injected' must be an array"
      log.error(msg)
      throw new ConfigError(msg)
    }
  } else {
    cfg.injected = [];
  }

  if (!cfg.settings || typeof cfg.settings !== "object" || Array.isArray(cfg.settings)) {
    cfg.settings = {};
  }
  const settings = cfg.settings as Record<string, unknown>;
  if (typeof settings.debounceMs !== "number") {
    settings.debounceMs = 3000;
  }
  if (typeof settings.reServeDelayMs !== "number") {
    settings.reServeDelayMs = DEFAULT_RESERVE_DELAY_MS;
  }
  if (typeof settings.tokenProfile !== "string") {
    settings.tokenProfile = "medium";
  }

  if (cfg.commandTimeouts && typeof cfg.commandTimeouts === "object" && !Array.isArray(cfg.commandTimeouts)) {
    const timeouts: Record<string, number> = {};
    for (const [key, val] of Object.entries(cfg.commandTimeouts as Record<string, unknown>)) {
      if (typeof val === "number" && val > 0) {
        timeouts[key] = val;
      }
    }
    cfg.commandTimeouts = timeouts;
  } else {
    cfg.commandTimeouts = {};
  }

  return cfg as unknown as PipeConfig;
}

export function loadConfig(): PipeConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = YAML.parse(raw);
    return validateConfig(parsed);
  } catch (err: unknown) {
    if (err instanceof ConfigError) throw err
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      log.error("Config file not found. Run `pmd init` first.");
      throw new ConfigError("Config file not found. Run `pmd init` first.")
    } else {
      const msg = "Config file invalid. " + errMsg(err)
      log.error(msg)
      throw new ConfigError(msg)
    }
  }
}
