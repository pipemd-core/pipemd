import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
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
  ContextFileRule,
} from "./injection-types.js";
import { checkInjectionStatus, recordInjection } from "./dedup.js";
import { listSessions, findConflicts, resolveAgentIdentity, resolveActiveSession } from "./crew.js";
import { formatTimeAgo } from "./json-utils.js";
import { log, errMsg } from "./logger.js";
import { invalidateCachePattern } from "./cache.js";
import { getTasksForSession, formatTaskBlock } from "./tasks.js";

const execFileAsync = promisify(execFile);

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

type SourceResolver = (ctx: ResolverContext) => Promise<string>;

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
  if (injectionTimestamps.size > MAX_SESSION_TRACKS) {
    for (const [key, ts] of injectionTimestamps) {
      while (ts.length > 0 && ts[0] < cutoff) ts.shift()
      if (ts.length === 0) injectionTimestamps.delete(key)
    }
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
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const extra = lines.length - maxLines;
  return lines.slice(0, maxLines).join("\n") + `\n... (+${extra} more)`;
}

async function runGitAsync(args: string[], fallback: string = ""): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      encoding: "utf-8",
      timeout: 5000,
    });
    return stdout.trim();
  } catch (err: unknown) {
    log.debug(`runGitAsync failed: ${errMsg(err)}`);
    return fallback;
  }
}

async function resolveCrewStatus(_ctx: ResolverContext): Promise<string> {
  const sessions = listSessions();
  if (sessions.length === 0) return "";

  const hasRemote = sessions.some((s) => s._remote);
  const conflicts = findConflicts(sessions);
  if (sessions.length === 1 && !hasRemote && conflicts.length === 0) return "";

  const lines: string[] = [];
  for (const s of sessions) {
    const claimed = s.claimedFiles.map((c) => c.path).join(", ") || "none";
    const origin = s._origin ? ` from ${s._origin}` : "";
    lines.push(`Crew: ${sessions.length} session(s) — ${s.harness} (${s.id}, claimed: ${claimed})${origin}`);
    if (s.note) lines.push(`  note: ${s.note}`);
  }

  for (const c of conflicts) {
    lines.push(`⚠️ CONFLICT: ${c.path} claimed by ${c.sessionIds.join(", ")}`);
  }

  return lines.slice(0, 8).join("\n");
}

async function resolveCrewLocks(ctx: ResolverContext): Promise<string> {
  const file = ctx.targetFile;
  if (!file) return "";

  const sessions = listSessions();
  const claimers = sessions.filter((s) =>
    s.claimedFiles.some((c) => c.path === file),
  );

  if (claimers.length === 0) return "";

  if (claimers.length === 1) {
    const s = claimers[0];
    const claim = s.claimedFiles.find((c) => c.path === file)!;
    const ago = formatTimeAgo(claim.claimedAt);
    return `File ${file}: claimed by ${s.harness} (${s.id}) ${ago} ago`;
  }

  const ids = claimers.map((s) => `${s.harness} (${s.id})`).join(", ");
  return `⚠️ CONFLICT on ${file}: ${ids}`;
}

async function resolveCrewTodos(_ctx: ResolverContext): Promise<string> {
  const sessions = listSessions();
  const hasRemote = sessions.some((s) => s._remote);
  if (sessions.length < 2 && !hasRemote) return "";

  const entry = readCache("crew-todos");
  if (!entry || !entry.data) return "";

  try {
    const todos: Array<{ content: string; status: string; priority: string }> = JSON.parse(entry.data);
    if (!Array.isArray(todos) || todos.length === 0) return "";
    const lines = todos.slice(0, 5).map((t) => `${t.status === "in_progress" ? "▶" : "○"} ${t.content} [${t.priority}]`);
    return lines.join("\n");
  } catch { return ""; }
}

async function resolveValidation(ctx: ResolverContext): Promise<string> {
  const file = ctx.targetFile;
  if (!file) return "";
  const entry = readCache(`validation:${file}`);
  if (entry && entry.data) return entry.data;
  return "";
}

async function resolveFileErrors(ctx: ResolverContext): Promise<string> {
  return resolveValidation(ctx);
}

async function resolveGitContext(ctx: ResolverContext): Promise<string> {
  const file = ctx.targetFile;
  if (!file) return "";

  if (ctx.trigger === "before-edit") {
    const cacheKey = `last-read:${ctx.sessionId || ""}:${file}`;
    const cached = readCache(cacheKey);
    if (!cached) return "";
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs > cached.timestamp) {
        return `⚠️ ${path.basename(file)} was modified externally since you last read it`;
      }
    } catch { return ""; }
    return "";
  }

  const cacheKey = `git-context:${file}`;
  const cached = readCache(cacheKey);
  if (cached && cached.data) return cached.data;

  const result = await runGitAsync(["log", "-1", "--format=%an, %ar", "--", file]);
  if (!result) return "";

  const content = `Last edit: ${result}`;
  writeCache(cacheKey, content, DEFAULT_TTLS["git-delta"] ?? 10000);
  return content;
}

async function resolveGitDelta(_ctx: ResolverContext): Promise<string> {
  const cached = readCache("git-status");
  let status: string;

  if (cached && cached.data) {
    status = cached.data;
  } else {
    status = await runGitAsync(["status", "--porcelain"]);
    if (!status) return "Not a git repo";
    writeCache("git-status", status, DEFAULT_TTLS["git-status"] ?? 10000);
  }

  if (!status.trim()) return "";

  const lines = status.trim().split("\n");
  const modified = lines.filter((l) => l.startsWith(" M")).length;
  const staged = lines.filter((l) => l.startsWith("M ") || l.startsWith("A ") || l.startsWith("R ")).length;
  const untracked = lines.filter((l) => l.startsWith("??")).length;

  const parts: string[] = [];
  if (modified > 0) parts.push(`${modified} modified`);
  if (staged > 0) parts.push(`${staged} staged`);
  if (untracked > 0) parts.push(`${untracked} untracked`);

  return parts.join(", ") || "";
}

async function resolveCustom(ctx: ResolverContext): Promise<string> {
  const config = ctx.config;
  const rules = getRulesForTrigger(config, ctx.trigger);
  const customRule = rules.find((r) => r.source === "custom" && r.command);
  if (!customRule || !customRule.command) return "";

  if (!config.customCommandsAllowed) {
    log.warn(`Custom command blocked: "${customRule.command}". Set customCommandsAllowed: true in injection.yml to enable.`);
    return "";
  }

  try {
    const parts = customRule.command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: "utf-8",
      timeout: 5000,
    });
    return stdout.trim();
  } catch (err: unknown) {
    log.debug(`resolveCustom command failed: ${errMsg(err)}`);
    return "";
  }
}

async function resolveGitStaged(_ctx: ResolverContext): Promise<string> {
  return await runGitAsync(["diff", "--cached", "--stat"], "");
}

async function resolveGitDiffStat(_ctx: ResolverContext): Promise<string> {
  return await runGitAsync(["diff", "--stat"], "");
}

async function resolveEditDiff(ctx: ResolverContext): Promise<string> {
  const file = ctx.targetFile;
  if (!file) return "";
  const cacheKey = `edit-diff:${file}`;
  const cached = readCache(cacheKey);
  if (cached && cached.data) return cached.data;

  const result = await runGitAsync(["diff", "--", file]);
  if (!result) return "";

  const lines = result.split("\n").filter((l) =>
    l.startsWith("+++") || l.startsWith("---") || l.startsWith("@@") || l.startsWith("-") || l.startsWith("+")
  );
  const diff = lines.length > 40
    ? lines.slice(0, 40).join("\n") + `\n... (+${lines.length - 40} more diff lines)`
    : lines.join("\n");

  writeCache(cacheKey, diff, 5000);
  return diff;
}

const SYNTAX_EXT_MAP: Record<string, string> = {
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
  ".jsx": "node",
};

async function resolveSyntaxCheck(ctx: ResolverContext): Promise<string> {
  const file = ctx.targetFile;
  if (!file) return "";

  const cacheKey = `syntax-check:${file}`;
  const cached = readCache(cacheKey);
  if (cached && cached.data) return cached.data;

  const ext = path.extname(file);
  const checker = SYNTAX_EXT_MAP[ext];
  if (!checker) return "";

  try {
    await execFileAsync("node", ["--check", file], {
      encoding: "utf-8",
      timeout: 5000,
    });
    const content = "No syntax errors";
    writeCache(cacheKey, content, DEFAULT_TTLS["syntax-check"] ?? 10000);
    return content;
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string } | null;
    const detail = e?.stderr?.trim() || e?.message || "Syntax error";
    const lines = detail.split("\n").slice(0, 5).join("\n");
    writeCache(cacheKey, lines, DEFAULT_TTLS["syntax-check"] ?? 10000);
    return lines;
  }
}

async function resolveTestFailures(_ctx: ResolverContext): Promise<string> {
  const cached = readCache("test-failures");
  if (cached) {
    return cached.data === "__all_pass__" ? "" : cached.data;
  }

  let pkgJson: { scripts?: Record<string, unknown> };
  try {
    const raw = fs.readFileSync("package.json", "utf-8");
    pkgJson = JSON.parse(raw);
  } catch {
    return "";
  }

  const scripts = pkgJson.scripts;
  if (!scripts || typeof scripts !== "object") return "";

  const testCmd = scripts["test:unit"] || scripts["test"];
  if (!testCmd || typeof testCmd !== "string") return "";

  const parts = testCmd.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  try {
    await execFileAsync(cmd, args, {
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    writeCache("test-failures", "__all_pass__", DEFAULT_TTLS["test-failures"] ?? 60000);
    return "";
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    const output = `${e.stdout || ""}\n${e.stderr || ""}`.trim();

    const failMatch = output.match(/# fail\s+(\d+)/);
    if (failMatch && parseInt(failMatch[1], 10) === 0) {
      writeCache("test-failures", "__all_pass__", DEFAULT_TTLS["test-failures"] ?? 60000);
      return "";
    }

    if (!failMatch && !output.includes("not ok") && !output.includes("FAIL")) {
      writeCache("test-failures", "__all_pass__", DEFAULT_TTLS["test-failures"] ?? 60000);
      return "";
    }

    const lines = output.split("\n");
    const failures: string[] = [];
    for (const line of lines) {
      if (line.startsWith("not ok")) {
        failures.push(line.trim());
      }
    }

    const failCount = failMatch ? parseInt(failMatch[1], 10) : failures.length;
    if (failCount === 0) {
      writeCache("test-failures", "__all_pass__", DEFAULT_TTLS["test-failures"] ?? 60000);
      return "";
    }

    const summary = `${failCount} test(s) failed:\n${failures.map((f) => `• ${f}`).join("\n")}`;
    const result = summary.split("\n").slice(0, 20).join("\n");
    writeCache("test-failures", result, DEFAULT_TTLS["test-failures"] ?? 60000);
    return result;
  }
}

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "__pycache__", ".next", ".nuxt", "coverage", ".cache"]);

function globToRegex(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "." || ch === "+" || ch === "^" || ch === "$" || ch === "|" || ch === "\\" || ch === "(" || ch === ")" || ch === "[" || ch === "]" || ch === "{" || ch === "}") {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

function collectFiles(root: string, pattern: string): string[] {
  const regex = globToRegex(pattern);
  const results: string[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && regex.test(relPath)) {
        results.push(relPath);
      }
    }
  }

  walk(root);
  return results.sort();
}

async function resolveContextRules(ctx: ResolverContext): Promise<string> {
  const config = ctx.config;
  if (!config.contextFiles || config.contextFiles.length === 0) return "";

  const matching = config.contextFiles.filter((r: ContextFileRule) => r.trigger === ctx.trigger);
  if (matching.length === 0) return "";

  const cwd = process.cwd();
  const parts: string[] = [];

  for (const rule of matching) {
    const files = collectFiles(cwd, rule.glob);
    const maxLines = rule["max-lines"] ?? 50;
    for (const relPath of files) {
      try {
        const content = fs.readFileSync(path.join(cwd, relPath), "utf-8");
        if (!content.trim()) continue;
        const lines = content.split("\n");
        const truncated = lines.length <= maxLines
          ? content
          : lines.slice(0, maxLines).join("\n") + `\n... (+${lines.length - maxLines} more)`;
        parts.push(`=== ${relPath} ===\n${truncated}`);
      } catch (err: unknown) {
        log.debug(`resolveContextRules: failed to read ${relPath}: ${errMsg(err)}`);
      }
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : "";
}

async function resolveHandoff(_ctx: ResolverContext): Promise<string> {
  const tasks = getTasksForSession();
  return formatTaskBlock(tasks);
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

async function resolveImportGraph(ctx: ResolverContext): Promise<string> {
  const file = ctx.targetFile;
  if (!file) return "";

  const cacheKey = `import-graph:${file}`;
  const cached = readCache(cacheKey);
  if (cached && cached.data) return cached.data;

  const ext = path.extname(file);
  const isTS = ext === ".ts" || ext === ".tsx";
  const isJS = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";

  if (!isTS && !isJS) return "";

  const includeFlags = isTS
    ? ["--include=*.ts", "--include=*.tsx"]
    : ["--include=*.js", "--include=*.jsx", "--include=*.mjs"];

  const relPath = toPosix(file.replace(/^\.\//, ""));
  const withoutExt = relPath.replace(/\.\w+$/, "");
  const baseName = path.basename(file, ext);

  const lines: string[] = [];

  const escapedBase = baseName.replace(/\./g, "\\.");
  const sq = "'";
  const dq = '"';
  const importPattern = `from\\s+(${sq}[^${sq}]*${escapedBase}[^${sq}]*${sq}|${dq}[^${dq}]*${escapedBase}[^${dq}]*${dq})`;
  const validTargets = new Set([
    withoutExt,
    relPath,
    withoutExt + ext,
    withoutExt + ".js",
    withoutExt + ".ts",
    withoutExt + ".tsx",
    withoutExt + ".jsx",
    withoutExt + ".mjs",
    withoutExt + ".cjs",
  ]);

  try {
    const { stdout: importedBy } = await execFileAsync(
      "grep",
      ["-rnE", importPattern, ...includeFlags, "src/"],
      { encoding: "utf-8", timeout: 5000 },
    );
    const whoImports = importedBy.trim().split("\n").filter(Boolean);
    const confirmed: string[] = [];
    for (const line of whoImports) {
      const m = line.match(/from\s+['"]([^'"]+)['"]/);
      if (!m) continue;
      const importSpec = m[1];
      if (!importSpec.startsWith(".")) continue;
      const consumerFile = line.split(":")[0];
      const consumerDir = toPosix(path.dirname(consumerFile));
      const resolved = toPosix(path.normalize(path.join(consumerDir, importSpec)));
      const resolvedNoExt = resolved.replace(/\.\w+$/, "");
      if (validTargets.has(resolved) || validTargets.has(resolvedNoExt)) {
        confirmed.push(line);
      }
    }
    if (confirmed.length > 0) {
      lines.push("Imported by:");
      for (const line of confirmed.slice(0, 15)) {
        lines.push(`  ${line}`);
      }
      if (confirmed.length > 15) lines.push(`  ... +${confirmed.length - 15} more`);
    }
  } catch { /* no matches */ }

  try {
    const { stdout } = await execFileAsync(
      "grep",
      ["-rnE", "from\\s+['\"]", ...includeFlags, file],
      { encoding: "utf-8", timeout: 5000 },
    );
    const imports = stdout.trim().split("\n").filter(Boolean);
    if (imports.length > 0) {
      lines.push("Imports:");
      const importPaths = new Set<string>();
      for (const line of imports) {
        const m = line.match(/from\s+['"]([^'"]+)['"]/);
        if (m) importPaths.add(m[1]);
      }
      for (const name of [...importPaths].slice(0, 15)) {
        lines.push(`  ${name}`);
      }
    }
  } catch { /* no matches */ }

  if (lines.length === 0) return "";
  const result = lines.join("\n");
  writeCache(cacheKey, result, DEFAULT_TTLS["git-delta"] ?? 10000);
  return result;
}

async function resolveSessionDiff(_ctx: ResolverContext): Promise<string> {
  const session = resolveActiveSession();
  if (!session || session.claimedFiles.length === 0) return "";

  const files = session.claimedFiles.map((c) => c.path);
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--stat", "--", ...files], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (!stdout.trim()) return "";
    const lines = stdout.trim().split("\n");
    return lines.length > 20
      ? lines.slice(0, 20).join("\n") + `\n... (+${lines.length - 20} more)`
      : lines.join("\n");
  } catch (err: unknown) {
    log.debug(`resolveSessionDiff failed: ${errMsg(err)}`);
    return "";
  }
}

export const RESOLVERS: Record<ContextSource, SourceResolver> = {
  "crew-status": resolveCrewStatus,
  "crew-locks": resolveCrewLocks,
  "crew-todos": resolveCrewTodos,
  "file-errors": resolveFileErrors,
  "git-context": resolveGitContext,
  "git-delta": resolveGitDelta,
  "git-staged": resolveGitStaged,
  "git-diff-stat": resolveGitDiffStat,
  "edit-diff": resolveEditDiff,
  "syntax-check": resolveSyntaxCheck,
  "test-failures": resolveTestFailures,
  custom: resolveCustom,
  "context-rules": resolveContextRules,
  handoff: resolveHandoff,
  "import-graph": resolveImportGraph,
  "session-diff": resolveSessionDiff,
};

const ESLINT_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);
const POST_EDIT_LINT_TIMEOUT_MS = 4000;

export async function buildPostEditFeedback(file: string): Promise<string | null> {
  if (!file) return null;
  const parts: string[] = [];

  try {
    const conflict = await resolveCrewLocks({
      trigger: "before-edit",
      targetFile: file,
      config: loadInjectionConfig(),
    });
    if (conflict && conflict.startsWith("⚠️ CONFLICT")) {
      parts.push(`[pmd] ${conflict}`);
    }
  } catch (err: unknown) { log.debug(`buildPostEditFeedback conflict check failed: ${errMsg(err)}`); }

  const ext = path.extname(file).toLowerCase();
  if (ESLINT_EXTS.has(ext)) {
    try {
      const lint = await new Promise<string>((resolve) => {
        execFile("npx", ["eslint", file, "--no-color"], { timeout: POST_EDIT_LINT_TIMEOUT_MS }, (err, stdout) => {
          if (err && typeof stdout === "string") {
            const out = stdout.trim();
            resolve(out ? out.split("\n").slice(0, 5).join("\n") : "");
          } else {
            resolve("");
          }
        });
      });
      if (lint) parts.push(`[pmd] ⚠ errors in ${file}:\n${lint}`);
    } catch (err: unknown) { log.debug(`buildPostEditFeedback lint failed: ${errMsg(err)}`); }
  }

  return parts.length === 0 ? null : parts.join("\n");
}

function deriveStableSessionId(): string {
  const { pid, harness } = resolveAgentIdentity();
  return computePayloadHash(`${process.cwd()}:${pid}:${harness}`);
}

export async function resolveInjections(
  trigger: InjectionTrigger,
  targetFile?: string,
  sessionId?: string,
  verbose?: boolean,
): Promise<InjectionPayload[]> {
  const config = loadInjectionConfig();
  const rules = getRulesForTrigger(config, trigger);
  const effectiveSessionId = sessionId || deriveStableSessionId()

  if (isRateLimited(effectiveSessionId)) {
    return []
  }

  const activeSession = resolveActiveSession();
  const sessionSources = activeSession?.sources;
  const sourceFilter = sessionSources?.length
    ? new Set(sessionSources)
    : null;

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

    if (sourceFilter && !sourceFilter.has(rule.source)) continue;

    const content = await resolver(ctx);

    if (!content) continue;

    if (verbose) {
      const elapsed = Date.now() - resolverStart;
      const truncated = rule["max-lines"] ? ` (truncated to ${rule["max-lines"]} lines)` : "";
      process.stderr.write(`[pmd:inject] resolving ${rule.source} → ${content.length} bytes${truncated} (${elapsed}ms)\n`);
    }

    const finalContent = rule["max-lines"]
      ? truncateLines(content, rule["max-lines"])
      : content;

    const hash = computePayloadHash(finalContent);
    const status = checkInjectionStatus(effectiveSessionId, rule.source, finalContent);

    if (status === "unchanged") {
      if (verbose) process.stderr.write(`[pmd:inject] dedup: ${rule.source} unchanged, skipping\n`);
      continue;
    }

    recordInjection(effectiveSessionId, rule.source, finalContent)
    recordInjectionTimestamp(effectiveSessionId)

    payloads.push({
      trigger,
      source: rule.source,
      scope: rule.scope,
      targetFile,
      content: finalContent,
      hash,
    });
  }

  return payloads;
}

export async function triggerAsyncValidation(filePath: string): Promise<void> {
  const cacheKey = `validation:${filePath}`;
  const guardKey = "validation:running";
  if (isFresh(guardKey)) return;
  writeCache(guardKey, "1", VALIDATION_COOLDOWN_MS);

  try {
    const errors: string[] = [];

    try {
      const eslintResult = await new Promise<string>((resolve) => {
        execFile("npx", ["eslint", filePath, "--no-color"], {
          timeout: 10000,
        }, (err, stdout) => {
          if (err) {
            if (stdout && typeof stdout === "string") {
              const out = stdout.trim();
              if (out) errors.push(out);
            }
            resolve("");
          } else {
            resolve(typeof stdout === "string" ? stdout.trim() : "");
          }
        });
      });
      if (eslintResult) errors.push(eslintResult);
    } catch (err: unknown) { log.debug(`eslint validation failed: ${errMsg(err)}`); }

    try {
      const tscResult = await new Promise<string>((resolve) => {
        execFile("npx", ["tsc", "--noEmit"], {
          timeout: 30000,
        }, (err, stdout) => {
          if (err) {
            if (stdout && typeof stdout === "string") {
              const out = stdout.trim();
              const relevant = out.split("\n").filter((l) => l.includes(filePath));
              resolve(relevant.length > 0 ? relevant.join("\n") : "");
            } else {
              resolve("");
            }
          } else {
            resolve(typeof stdout === "string" ? stdout.trim() : "");
          }
        });
      });
      if (tscResult) {
        const relevant = tscResult.split("\n").filter((l) => l.includes(filePath));
        if (relevant.length > 0) errors.push(...relevant);
      }
    } catch (err: unknown) { log.debug(`tsc validation failed: ${errMsg(err)}`); }

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
