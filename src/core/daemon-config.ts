import fs from "node:fs";
import YAML from "yaml";
import { DEFAULT_RESERVE_DELAY_MS } from "../config.js";
import type { PipeConfig } from "../config.js";
import { CONFIG_PATH } from "./paths.js";
import { log } from "./logger.js";

export function validateConfig(raw: unknown): PipeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    log.error("Invalid config.yml: expected a mapping (object), got " + (raw === null ? "null" : typeof raw));
    process.exit(1);
  }

  const cfg = raw as Record<string, unknown>;

  if (!cfg.commands || typeof cfg.commands !== "object" || Array.isArray(cfg.commands)) {
    if (cfg.commands === undefined || cfg.commands === null) {
      log.error("Invalid config.yml: missing 'commands' — nothing to render. Run `pmd init` to regenerate.");
      process.exit(1);
    }
    log.error("Invalid config.yml: 'commands' must be a mapping of name → shell command");
    process.exit(1);
  }

  if (cfg.pipes !== undefined && cfg.pipes !== null) {
    if (!Array.isArray(cfg.pipes)) {
      log.error("Invalid config.yml: 'pipes' must be an array");
      process.exit(1);
    }
  } else {
    cfg.pipes = [];
  }

  if (cfg.injected !== undefined && cfg.injected !== null) {
    if (!Array.isArray(cfg.injected)) {
      log.error("Invalid config.yml: 'injected' must be an array");
      process.exit(1);
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

  return cfg as unknown as PipeConfig;
}

export function loadConfig(): PipeConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = YAML.parse(raw);
    return validateConfig(parsed);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      log.error("Config file not found. Run `pmd init` first.");
    } else {
      log.error("Config file invalid. " + (err instanceof Error ? err.message : String(err)));
    }
    process.exit(1);
  }
}
