import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { log, errMsg } from "./logger.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type DeliveryMode = "passive" | "active" | "expert";

export type InjectionTrigger = "before-read" | "before-edit" | "after-edit" | "on-idle" | "on-start";

export type ContextSource =
  | "crew-status"
  | "crew-locks"
  | "crew-todos"
  | "file-errors"
  | "git-context"
  | "git-delta"
  | "git-staged"
  | "git-diff-stat"
  | "edit-diff"
  | "syntax-check"
  | "test-failures"
  | "custom"
  | "handoff"
  | "import-graph"
  | "session-diff"
  | "exports"
  | "file-content"
  | "now";

type InjectionScope = "target-file" | "global";

export interface InjectionRule {
  source: ContextSource;
  scope: InjectionScope;
  "max-lines"?: number;
  async?: boolean;
  command?: string;
  label?: string;
  "interval-min"?: number;
}

export interface InjectionConfig {
  delivery: DeliveryMode;
  rules: Partial<Record<InjectionTrigger, InjectionRule[]>>;
  customCommandsAllowed?: boolean;
}

export interface InjectionPayload {
  trigger: InjectionTrigger;
  source: ContextSource;
  scope: InjectionScope;
  targetFile?: string;
  content: string;
  hash: string;
}

const VALID_DELIVERY_MODES: DeliveryMode[] = ["passive", "active", "expert"];
const VALID_TRIGGERS: InjectionTrigger[] = ["before-read", "before-edit", "after-edit", "on-idle", "on-start"];
const VALID_SOURCES: ContextSource[] = [
  "crew-status",
  "crew-locks",
  "crew-todos",
  "file-errors",
  "git-context",
  "git-delta",
  "git-staged",
  "git-diff-stat",
  "edit-diff",
  "syntax-check",
  "test-failures",
  "custom",
  "handoff",
  "import-graph",
  "session-diff",
  "exports",
  "file-content",
  "now",
];
const VALID_SCOPES: InjectionScope[] = ["target-file", "global"];

export const DEFAULT_ACTIVE_RULES: InjectionConfig = {
  delivery: "active",
  rules: {
    "before-read": [
      { source: "crew-status", scope: "global", "max-lines": 3 },
    ],
    "before-edit": [
      { source: "crew-locks", scope: "target-file" },
      { source: "import-graph", scope: "target-file", "max-lines": 25 },
      { source: "exports", scope: "target-file", "max-lines": 15 },
      { source: "syntax-check", scope: "target-file", "max-lines": 5 },
      { source: "file-errors", scope: "target-file", "max-lines": 15 },
      { source: "git-context", scope: "target-file", "max-lines": 2 },
    ],
    "after-edit": [
      { source: "edit-diff", scope: "target-file", async: true, "max-lines": 20 },
      { source: "syntax-check", scope: "target-file", async: true, "max-lines": 5 },
      { source: "file-errors", scope: "target-file", async: true, "max-lines": 15 },
    ],
    "on-start": [
      { source: "now", scope: "global", "interval-min": 1 },
      { source: "handoff", scope: "global", "max-lines": 30 },
    ],
    "on-idle": [],
  },
};

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function validateRule(raw: unknown, context?: string): InjectionRule | null {
  if (typeof raw !== "object" || raw === null) {
    log.warn(`Injection rule ignored: expected object, got ${raw === null ? "null" : typeof raw}${context ? ` in ${context}` : ""}`);
    return null;
  }
  const obj = raw as Record<string, unknown>;

  if (!isString(obj.source) || !VALID_SOURCES.includes(obj.source as ContextSource)) {
    log.warn(`Injection rule ignored: invalid source "${obj.source}"${context ? ` in ${context}` : ""}. Valid: ${VALID_SOURCES.join(", ")}`);
    return null;
  }
  if (!isString(obj.scope) || !VALID_SCOPES.includes(obj.scope as InjectionScope)) {
    log.warn(`Injection rule ignored: invalid scope "${obj.scope}" for source "${obj.source}"${context ? ` in ${context}` : ""}`);
    return null;
  }

  const rule: InjectionRule = {
    source: obj.source as ContextSource,
    scope: obj.scope as InjectionScope,
  };

  if (obj["max-lines"] != null) {
    const ml = Number(obj["max-lines"]);
    if (!Number.isFinite(ml) || ml < 1) {
      log.warn(`Injection rule for "${obj.source}": invalid max-lines ${JSON.stringify(obj["max-lines"])} (must be positive number), ignoring`);
      return null;
    }
    rule["max-lines"] = ml;
  }

  if (obj.async != null) {
    if (typeof obj.async !== "boolean") {
      log.warn(`Injection rule for "${obj.source}": invalid async ${JSON.stringify(obj.async)}, ignoring`);
      return null;
    }
    rule.async = obj.async;
  }

  if (obj.command != null) {
    if (!isString(obj.command)) {
      log.warn(`Injection rule for "${obj.source}": invalid command ${JSON.stringify(obj.command)}, ignoring`);
      return null;
    }
    rule.command = obj.command;
  }

  if (obj.label != null) {
    if (!isString(obj.label)) {
      log.warn(`Injection rule for "${obj.source}": invalid label ${JSON.stringify(obj.label)}, ignoring`);
      return null;
    }
    rule.label = obj.label;
  }

  if (obj["interval-min"] != null) {
    const im = Number(obj["interval-min"]);
    if (!Number.isFinite(im) || im < 1) {
      log.warn(`Injection rule for "${obj.source}": invalid interval-min ${JSON.stringify(obj["interval-min"])} (must be positive number), ignoring`);
      return null;
    }
    rule["interval-min"] = im;
  }

  return rule;
}

export function parseInjectionConfig(raw: unknown): InjectionConfig {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_ACTIVE_RULES };
  }

  const obj = raw as Record<string, unknown>;

  let delivery: DeliveryMode = "active";
  if (isString(obj.delivery) && VALID_DELIVERY_MODES.includes(obj.delivery as DeliveryMode)) {
    delivery = obj.delivery as DeliveryMode;
  }

  if (delivery === "passive") {
    return { delivery: "passive", rules: {} };
  }

  const rules: Partial<Record<InjectionTrigger, InjectionRule[]>> = {};

  if (typeof obj.rules === "object" && obj.rules !== null) {
    const rawRules = obj.rules as Record<string, unknown>;
    for (const key of Object.keys(rawRules)) {
      if (!VALID_TRIGGERS.includes(key as InjectionTrigger)) {
        log.warn(`Injection config: unknown trigger "${key}" ignored. Valid: ${VALID_TRIGGERS.join(", ")}`);
        continue;
      }
      const trigger = key as InjectionTrigger;
      const arr = rawRules[trigger];
      if (!Array.isArray(arr)) {
        log.warn(`Injection config: trigger "${trigger}" must be an array, got ${typeof arr}`);
        continue;
      }
      const validated: InjectionRule[] = [];
      for (const item of arr) {
        const rule = validateRule(item, trigger);
        if (rule) validated.push(rule);
      }
      if (validated.length > 0) {
        rules[trigger] = validated;
      }
    }
  }

  if (delivery === "active" && Object.keys(rules).length === 0) {
    return { ...DEFAULT_ACTIVE_RULES };
  }

  const customCommandsAllowed = obj.customCommandsAllowed === true;

  const result: InjectionConfig = { delivery, rules, customCommandsAllowed: customCommandsAllowed || undefined };
  return result;
}

/** Top-level config keys that were removed from the schema; their presence means a stale config. */
const REMOVED_CONFIG_KEYS = ["context-files"];

/**
 * Strict validation for committed/scaffolded injection configs. Unlike parseInjectionConfig
 * (which warns and silently drops bad rules), this collects every problem so callers — tests
 * and `pmd validate` — can fail hard on drift between the YAML and the engine's schema.
 * Returns a list of human-readable issues; empty means the config is clean.
 */
export function findInjectionConfigIssues(raw: unknown): string[] {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return ["config is not an object"];
  }
  const obj = raw as Record<string, unknown>;

  for (const key of REMOVED_CONFIG_KEYS) {
    if (key in obj) issues.push(`removed config key "${key}" is still present`);
  }

  if (typeof obj.rules === "object" && obj.rules !== null) {
    const rawRules = obj.rules as Record<string, unknown>;
    for (const trigger of Object.keys(rawRules)) {
      if (!VALID_TRIGGERS.includes(trigger as InjectionTrigger)) {
        issues.push(`unknown trigger "${trigger}"`);
        continue;
      }
      const arr = rawRules[trigger];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (typeof item !== "object" || item === null) continue;
        const src = (item as Record<string, unknown>).source;
        if (!isString(src) || !VALID_SOURCES.includes(src as ContextSource)) {
          issues.push(`unknown source "${String(src)}" in trigger "${trigger}"`);
        }
      }
    }
  }

  return issues;
}

export function loadInjectionConfig(configDir?: string): InjectionConfig {
  const dir = configDir || path.resolve(process.cwd(), ".pipemd");

  const candidates = [
    path.join(dir, "injection.yml"),
    path.join(dir, "injection.yaml"),
  ];

  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = parseYaml(content);
      return parseInjectionConfig(parsed);
    } catch (err: unknown) {
      const msg = errMsg(err);
      if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      log.warn(`Failed to parse ${path.basename(filePath)}: ${msg}. Using defaults.`);
      return { ...DEFAULT_ACTIVE_RULES };
    }
  }

  return { ...DEFAULT_ACTIVE_RULES };
}

export function getRulesForTrigger(config: InjectionConfig, trigger: InjectionTrigger): InjectionRule[] {
  return config.rules[trigger] ?? [];
}

export function computePayloadHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function generateInjectionYml(config: InjectionConfig): string {
  const header = [
    "# PipeMD Injection Configuration",
    "#",
    "# delivery: passive | active | expert",
    "#   passive = render to file/pipe, no hooks",
    "#   active  = hooks installed, sensible defaults",
    "#   expert  = full customization of injection rules",
    "#",
    "# triggers: before-read | before-edit | after-edit | on-idle | on-start",
    "# sources:  crew-status | crew-locks | file-errors",
    "#           git-context | git-delta | git-staged | git-diff-stat",
    "#           edit-diff | syntax-check | test-failures | custom",
    "#           import-graph | handoff | session-diff | exports | now",
    "# scope:    target-file | global",
    "# interval-min: (now source only) minutes to round time to, controlling refresh frequency",
    "",
  ].join("\n");

  const yamlBody = stringifyYaml(
    { delivery: config.delivery, rules: config.rules },
    { lineWidth: 0, singleQuote: true }
  );

  return header + yamlBody;
}
