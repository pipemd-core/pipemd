import { execSync, execFileSync } from "node:child_process";
import { readCache, writeCache, isFresh, invalidate, DEFAULT_TTLS } from "./cache.js";
import {
  loadInjectionConfig,
  getRulesForTrigger,
  computePayloadHash,
} from "./injection-types.js";
import type {
  InjectionTrigger,
  InjectionConfig,
  InjectionPayload,
  ContextSource,
} from "./injection-types.js";
import { checkInjectionStatus, recordInjection } from "./dedup.js";
import { listSessions, findConflicts, resolveAgentIdentity } from "./crew.js";
import { formatTimeAgo } from "./json-utils.js";
import { log } from "./logger.js";

const VALIDATION_COOLDOWN_MS = 60_000
const RATE_LIMIT_WINDOW_MS = 10_000
const MAX_INJECTIONS_PER_WINDOW = 30
const RESOLVER_TOTAL_BUDGET_MS = 5000
const MAX_SESSION_TRACKS = 256
const injectionTimestamps = new Map<string, number[]>()

export interface ResolverContext {
  trigger: InjectionTrigger;
  targetFile?: string;
  sessionId?: string;
  config: InjectionConfig;
}

type SourceResolver = (ctx: ResolverContext) => string;

function isRateLimited(sessionId: string): boolean {
  const now = Date.now()
  let timestamps = injectionTimestamps.get(sessionId)
  if (!timestamps) {
    timestamps = []
    injectionTimestamps.set(sessionId, timestamps)
  }
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift()
  }
  return timestamps.length >= MAX_INJECTIONS_PER_WINDOW
}

function recordInjectionTimestamp(sessionId: string): void {
  const now = Date.now()
  let timestamps = injectionTimestamps.get(sessionId)
  if (!timestamps) {
    timestamps = []
    injectionTimestamps.set(sessionId, timestamps)
  }
  timestamps.push(now)
  if (injectionTimestamps.size > MAX_SESSION_TRACKS) {
    const cutoff = now - RATE_LIMIT_WINDOW_MS
    for (const [key, ts] of injectionTimestamps) {
      while (ts.length > 0 && ts[0] < cutoff) ts.shift()
      if (ts.length === 0) injectionTimestamps.delete(key)
    }
  }
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const extra = lines.length - maxLines;
  return lines.slice(0, maxLines).join("\n") + `\n... (+${extra} more)`;
}

function runGit(args: string[], fallback: string = ""): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return fallback;
  }
}

function resolveCrewStatus(ctx: ResolverContext): string {
  const sessions = listSessions();
  const lines: string[] = [];

  if (sessions.length === 0) {
    lines.push("Crew: no active sessions");
  } else {
    for (const s of sessions) {
      const claimed = s.claimedFiles.map((c) => c.path).join(", ") || "none";
      lines.push(`Crew: ${sessions.length} session(s) — ${s.harness} (${s.id}, claimed: ${claimed})`);
    }
  }

  const conflicts = findConflicts(sessions);
  for (const c of conflicts) {
    lines.push(`⚠️ CONFLICT: ${c.path} claimed by ${c.sessionIds.join(", ")}`);
  }

  return lines.slice(0, 5).join("\n");
}

function resolveCrewLocks(ctx: ResolverContext): string {
  const file = ctx.targetFile;
  if (!file) return "No target file specified";

  const sessions = listSessions();
  const claimers = sessions.filter((s) =>
    s.claimedFiles.some((c) => c.path === file),
  );

  if (claimers.length === 0) {
    return `File ${file}: unclaimed`;
  }

  if (claimers.length === 1) {
    const s = claimers[0];
    const claim = s.claimedFiles.find((c) => c.path === file)!;
    const ago = formatTimeAgo(claim.claimedAt);
    return `File ${file}: claimed by ${s.harness} (${s.id}) ${ago} ago`;
  }

  const ids = claimers.map((s) => `${s.harness} (${s.id})`).join(", ");
  return `⚠️ CONFLICT on ${file}: ${ids}`;
}

function resolveValidation(ctx: ResolverContext): string {
  const file = ctx.targetFile;
  if (!file) return "";
  const entry = readCache(`validation:${file}`);
  if (entry && entry.data) return entry.data;
  return "";
}

function resolveFileErrors(ctx: ResolverContext): string {
  const result = resolveValidation(ctx);
  return result || `No known errors in ${ctx.targetFile ?? "file"}`;
}

function resolveValidateFile(ctx: ResolverContext): string {
  return resolveValidation(ctx);
}

function resolveGitContext(ctx: ResolverContext): string {
  const file = ctx.targetFile;
  if (!file) return "No target file specified";

  const cacheKey = `git-context:${file}`;
  const cached = readCache(cacheKey);
  if (cached && cached.data) return cached.data;

  const result = runGit(["log", "-1", "--format=%an, %ar", "--", file]);
  if (!result) return "No git history for this file";

  const content = `Last edit: ${result}`;
  writeCache(cacheKey, content, DEFAULT_TTLS["git-delta"] ?? 10000);
  return content;
}

function resolveGitDelta(ctx: ResolverContext): string {
  const cached = readCache("git-status");
  let status: string;

  if (cached && cached.data) {
    status = cached.data;
  } else {
    status = runGit(["status", "--porcelain"]);
    if (!status) return "Not a git repo";
    writeCache("git-status", status, DEFAULT_TTLS["git-status"] ?? 10000);
  }

  if (!status.trim()) return "No changes since last check";

  const lines = status.trim().split("\n");
  const modified = lines.filter((l) => l.startsWith(" M")).length;
  const staged = lines.filter((l) => l.startsWith("M ") || l.startsWith("A ") || l.startsWith("R ")).length;
  const untracked = lines.filter((l) => l.startsWith("??")).length;

  const parts: string[] = [];
  if (modified > 0) parts.push(`${modified} modified`);
  if (staged > 0) parts.push(`${staged} staged`);
  if (untracked > 0) parts.push(`${untracked} untracked`);

  return parts.join(", ") || "No changes since last check";
}

function resolveCustom(ctx: ResolverContext): string {
  const config = ctx.config;
  const rules = getRulesForTrigger(config, ctx.trigger);
  const customRule = rules.find((r) => r.source === "custom" && r.command);
  if (!customRule || !customRule.command) return "";

  if (!config.customCommandsAllowed) {
    log.warn(`Custom command blocked: "${customRule.command}". Set customCommandsAllowed: true in injection.yml to enable.`);
    return "";
  }

  try {
    return execSync(customRule.command, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function resolveGitStaged(ctx: ResolverContext): string {
  try {
    const result = execFileSync("git", ["diff", "--cached", "--stat"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!result) return "No staged changes";
    return result;
  } catch {
    return "No staged changes";
  }
}

function resolveGitDiffStat(ctx: ResolverContext): string {
  try {
    const result = execFileSync("git", ["diff", "--stat"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!result) return "No unstaged changes";
    return result;
  } catch {
    return "No unstaged changes";
  }
}

const RESOLVERS: Record<ContextSource, SourceResolver> = {
  "crew-status": resolveCrewStatus,
  "crew-locks": resolveCrewLocks,
  "file-errors": resolveFileErrors,
  "validate-file": resolveValidateFile,
  "git-context": resolveGitContext,
  "git-delta": resolveGitDelta,
  "git-staged": resolveGitStaged,
  "git-diff-stat": resolveGitDiffStat,
  custom: resolveCustom,
};

function deriveStableSessionId(): string {
  const { pid, harness } = resolveAgentIdentity();
  return computePayloadHash(`${process.cwd()}:${pid}:${harness}`);
}

export function resolveInjections(
  trigger: InjectionTrigger,
  targetFile?: string,
  sessionId?: string,
): InjectionPayload[] {
  const config = loadInjectionConfig();
  const rules = getRulesForTrigger(config, trigger);
  const effectiveSessionId = sessionId || deriveStableSessionId()

  if (isRateLimited(effectiveSessionId)) {
    return []
  }

  const payloads: InjectionPayload[] = []
  const resolverStart = Date.now()

  for (const rule of rules) {
    if (Date.now() - resolverStart > RESOLVER_TOTAL_BUDGET_MS) {
      break
    }
    if (rule.scope === "target-file" && !targetFile) continue;

    const ctx: ResolverContext = {
      trigger,
      targetFile,
      sessionId: effectiveSessionId,
      config,
    };

    const resolver = RESOLVERS[rule.source];
    if (!resolver) continue;

    let content = resolver(ctx);

    if (rule["max-lines"]) {
      content = truncateLines(content, rule["max-lines"]);
    }

    const hash = computePayloadHash(content);
    const status = checkInjectionStatus(effectiveSessionId, rule.source, content);

    if (status === "unchanged") continue;

    recordInjection(effectiveSessionId, rule.source, content)
    recordInjectionTimestamp(effectiveSessionId)

    payloads.push({
      trigger,
      source: rule.source,
      scope: rule.scope,
      targetFile,
      content,
      hash,
    });
  }

  return payloads;
}

export function triggerAsyncValidation(filePath: string): void {
  const cacheKey = `validation:${filePath}`;
  if (isFresh(cacheKey)) return;

  const guardKey = "validation:running";
  if (isFresh(guardKey)) return;
  writeCache(guardKey, "1", VALIDATION_COOLDOWN_MS);

  try {
    const errors: string[] = [];

    try {
      const eslintResult = execFileSync("npx", ["eslint", filePath, "--format", "compact"], {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (eslintResult) errors.push(eslintResult);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "stdout" in err && typeof (err as { stdout: string }).stdout === "string") {
        const out = (err as { stdout: string }).stdout.trim();
        if (out) errors.push(out);
      }
    }

    try {
      const tscResult = execFileSync("npx", ["tsc", "--noEmit"], {
        encoding: "utf-8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (tscResult) {
        const relevant = tscResult.split("\n").filter((l) => l.includes(filePath));
        if (relevant.length > 0) errors.push(...relevant);
      }
    } catch (err: unknown) {
      if (err && typeof err === "object" && "stdout" in err && typeof (err as { stdout: string }).stdout === "string") {
        const out = (err as { stdout: string }).stdout.trim();
        if (out) {
          const relevant = out.split("\n").filter((l) => l.includes(filePath));
          if (relevant.length > 0) errors.push(...relevant);
        }
      }
    }

    const content = errors.length > 0 ? errors.join("\n") : "No errors found";
    writeCache(cacheKey, content, DEFAULT_TTLS.validation ?? 60000);
  } finally {
    invalidate(guardKey);
  }
}

export {
  RATE_LIMIT_WINDOW_MS,
  MAX_INJECTIONS_PER_WINDOW,
  RESOLVER_TOTAL_BUDGET_MS,
}

export function getValidationResult(filePath: string): string {
  const entry = readCache(`validation:${filePath}`);
  if (entry && entry.data) return entry.data;
  return "";
}
