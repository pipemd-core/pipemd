import { execFile, execFileSync } from "node:child_process";
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
  InjectionRule,
  ContextSource,
} from "./injection-types.js";
import { checkInjectionStatus, recordInjection } from "./dedup.js";
import { listSessions, findConflicts, resolveAgentIdentity, resolveActiveSession } from "./crew.js";
import { formatTimeAgo, buildSafeEnv } from "./json-utils.js";
import { log, errMsg } from "./logger.js";
import { getTasksForSession, formatTaskBlock } from "./tasks.js";
import { topologyAllows } from "./topology-filter.js";

const execFileAsync = promisify(execFile);

const VALIDATION_COOLDOWN_MS = 60_000
const RATE_LIMIT_WINDOW_MS = 10_000
const MAX_INJECTIONS_PER_WINDOW = 30
const RESOLVER_TOTAL_BUDGET_MS = 5000
const RESOLVER_PER_ITEM_MS = 4000
const MAX_SESSION_TRACKS = 256
const injectionTimestamps = new Map<string, number[]>()

interface ResolverContext {
  trigger: InjectionTrigger;
  targetFile?: string;
  sessionId?: string;
  config: InjectionConfig;
  intervalMin?: number;
  maxLines?: number;
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
  const hasClaims = sessions.some((s) => s.claimedFiles.length > 0);
  if (sessions.length === 1 && !hasRemote && conflicts.length === 0) return "";
  if (!hasRemote && conflicts.length === 0 && !hasClaims) return "";

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

async function resolveSessionValidate(_ctx: ResolverContext): Promise<string> {
  const session = resolveActiveSession();
  if (!session || session.claimedFiles.length === 0) return "";

  const files = session.claimedFiles.map((c) => c.path).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return ESLINT_EXTS.has(ext);
  });
  if (files.length === 0) return "";

  const cacheKey = `session-validate:${session.id}`;
  const cached = readCache(cacheKey);
  if (cached && cached.data) return cached.data;

  try {
    const { stdout } = await execFileAsync("npx", ["eslint", ...files, "--no-color", "--no-error-on-unmatched-pattern"], {
      encoding: "utf-8",
      timeout: 4000,
      cwd: process.cwd(),
    });
    const output = stdout.trim();
    if (!output) {
      const result = `✔ No errors in ${files.length} claimed file(s)`;
      writeCache(cacheKey, result, 30_000);
      return result;
    }
    const lines = output.split("\n").slice(0, 20);
    const result = lines.join("\n");
    writeCache(cacheKey, result, 30_000);
    return result;
  } catch (err: unknown) {
    const e = err as { stdout?: string } | null;
    const output = e?.stdout?.trim();
    if (output) {
      const lines = output.split("\n").slice(0, 20);
      const result = lines.join("\n");
      writeCache(cacheKey, result, 30_000);
      return result;
    }
    log.debug(`resolveSessionValidate failed: ${errMsg(err)}`);
    return "";
  }
}

async function resolveValidation(ctx: ResolverContext): Promise<string> {
  const file = ctx.targetFile;
  if (!file) return "";
  const entry = readCache(`validation:${file}`);
  if (entry && entry.data) {
    // Trust > coverage: if the file changed after we validated, the cached
    // result may describe a previous state — suppress it rather than present a
    // since-fixed error as current truth (the s1 "stale after fix" case).
    // We compare the validator-snapshotted mtime to the current mtime (same
    // statSync clock) so sub-ms cross-clock jitter can't flag fresh as stale.
    const storedMtime = entry.metadata?.mtime;
    if (storedMtime !== undefined) {
      try {
        if (fs.statSync(file).mtimeMs > Number(storedMtime)) return "";
      } catch { /* file missing — serve the cache rather than go blank */ }
    }
    return entry.data;
  }
  return "";
}

async function resolveGitContext(ctx: ResolverContext): Promise<string> {
  const file = ctx.targetFile;
  if (!file) return "";

  // H3 — Conditional: only inject when the file has uncommitted changes.
  // V10 found git-context is not significant (Δ = −12.4s, CI includes 0).
  // Don't waste tokens on clean files.
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--", file], {
      encoding: "utf-8", timeout: 2000,
    });
    if (!stdout.trim()) return "";
  } catch { return ""; }

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
      env: buildSafeEnv(),
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
  ".ts": "tsc",
  ".tsx": "tsc",
  ".py": "python",
  ".go": "go",
  ".rs": "cargo",
};

const TSC_CACHE_KEY = "syntax-check:tsc-project";
const TSC_CACHE_TTL = 30_000;
const CARGO_CACHE_KEY = "syntax-check:cargo-project";
const CARGO_CACHE_TTL = 30_000;

async function runProjectTypeCheck(
  cacheKey: string,
  cacheTtl: number,
  bin: string,
  args: string[],
  cwd: string,
): Promise<string | null> {
  const cached = readCache(cacheKey);
  if (cached && cached.data) return cached.data;
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      encoding: "utf-8",
      timeout: 15_000,
      cwd,
    });
    const output = (stdout + stderr).trim();
    writeCache(cacheKey, output, cacheTtl);
    return output;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string } | null;
    const output = ((e?.stdout ?? "") + (e?.stderr ?? "")).trim();
    if (output) {
      writeCache(cacheKey, output, cacheTtl);
      return output;
    }
    return null;
  }
}

function filterTypeCheckOutput(output: string, targetFile: string): string {
  const rel = path.relative(process.cwd(), targetFile);
  const lines = output.split("\n").filter((l) => {
    const trimmed = l.trim();
    return trimmed.startsWith(targetFile) || trimmed.startsWith(rel) ||
           trimmed.startsWith(`./${rel}`);
  });
  if (lines.length === 0) return "";
  return lines.slice(0, 5).join("\n");
}

async function resolveSyntaxCheck(ctx: ResolverContext): Promise<string> {
  const file = ctx.targetFile;
  if (!file) return "";

  const cacheKey = `syntax-check:${file}`;
  const cached = readCache(cacheKey);
  if (cached && cached.data) return cached.data;

  const ext = path.extname(file);
  const checker = SYNTAX_EXT_MAP[ext];
  if (!checker) return "";

  let result = "";

  if (checker === "node") {
    try {
      await execFileAsync("node", ["--check", file], {
        encoding: "utf-8",
        timeout: 5000,
      });
      result = "No syntax errors";
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string } | null;
      result = (e?.stderr?.trim() || e?.message || "Syntax error").split("\n").slice(0, 5).join("\n");
    }
  } else if (checker === "python") {
    try {
      await execFileAsync("python", ["-m", "py_compile", file], {
        encoding: "utf-8",
        timeout: 5000,
      });
      result = "No syntax errors";
    } catch (err: unknown) {
      const e = err as { stderr?: string } | null;
      result = (e?.stderr?.trim() || "Python syntax error").split("\n").slice(0, 5).join("\n");
    }
  } else if (checker === "go") {
    try {
      await execFileAsync("go", ["vet", file], {
        encoding: "utf-8",
        timeout: 8000,
      });
      result = "No issues";
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string } | null;
      result = (e?.stderr?.trim() || e?.stdout?.trim() || "Go vet error").split("\n").slice(0, 5).join("\n");
    }
  } else if (checker === "tsc") {
    const projectOutput = await runProjectTypeCheck(
      TSC_CACHE_KEY, TSC_CACHE_TTL,
      "npx", ["tsc", "--noEmit", "--pretty", "false"], process.cwd(),
    );
    if (projectOutput === null) {
      result = "";
    } else {
      const filtered = filterTypeCheckOutput(projectOutput, file);
      result = filtered || "No type errors";
    }
  } else if (checker === "cargo") {
    const projectOutput = await runProjectTypeCheck(
      CARGO_CACHE_KEY, CARGO_CACHE_TTL,
      "cargo", ["check", "--message-format=short"], process.cwd(),
    );
    if (projectOutput === null) {
      result = "";
    } else {
      const filtered = filterTypeCheckOutput(projectOutput, file);
      result = filtered || "No cargo errors";
    }
  }

  if (result) {
    writeCache(cacheKey, result, DEFAULT_TTLS["syntax-check"] ?? 10000);
  }
  return result;
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

async function resolveHandoff(_ctx: ResolverContext): Promise<string> {
  const tasks = getTasksForSession();
  return formatTaskBlock(tasks);
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function extractImportSpecifiers(line: string): string | null {
  const patterns = [
    /import\s+\{([^}]+)\}\s+from/,
    /import\s+type\s+\{([^}]+)\}\s+from/,
    /import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from/,
    /import\s+(\w+)\s+from/,
    /import\s+type\s+(\w+)\s+from/,
  ];
  for (const pat of patterns) {
    const m = line.match(pat);
    if (!m) continue;
    const names: string[] = [];
    if (m[1] && m[1].includes(",")) {
      names.push(...m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean));
    } else if (m[1]) {
      names.push(m[1].split(/\s+as\s+/).pop()!.trim());
    }
    if (m[2]) {
      names.push(...m[2].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean));
    }
    if (names.length > 0) return names.join(", ");
  }
  return null;
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

  const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const whoImports = importedBy.trim().split("\n").filter(Boolean).filter(line => {
      const content = line.replace(/^(?:[^:]+:)?\d+:/, "").trim();
      return !/^[*/]/.test(content) && !/^\/\//.test(content);
    });
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
      // C2 — Dependents-at-risk: when editing a hub file (many importers),
      // surface the blast radius prominently. V10: import-graph is the #3
      // reward block (−23.6s); risk context adds signal density.
      if (confirmed.length >= 5) {
        lines.push(`⚠️ Hub file — ${confirmed.length} dependents may be affected by this edit`);
      }
      lines.push("Imported by:");
      // Sort by coupling (importers with more specifiers first)
      const annotated = confirmed.map((line) => {
        const specifiers = extractImportSpecifiers(line);
        const consumerFile = line.split(":")[0];
        const coupling = specifiers ? specifiers.split(",").length : 1;
        return { consumerFile, specifiers, coupling };
      }).sort((a, b) => b.coupling - a.coupling);
      for (const { consumerFile, specifiers } of annotated.slice(0, 15)) {
        if (specifiers) {
          lines.push(`  ${consumerFile} → ${specifiers}`);
        } else {
          lines.push(`  ${consumerFile}`);
        }
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
    const imports = stdout.trim().split("\n").filter(Boolean).filter(line => {
      const content = line.replace(/^(?:[^:]+:)?\d+:/, "").trim();
      return !/^[*/]/.test(content) && !/^\/\//.test(content);
    });
    if (imports.length > 0) {
      lines.push("Imports:");
      const seen = new Map<string, string[]>();
      for (const line of imports) {
        const m = line.match(/from\s+['"]([^'"]+)['"]/);
        if (!m) continue;
        const importPath = m[1];
        const specifiers = extractImportSpecifiers(line);
        const existing = seen.get(importPath);
        if (existing && specifiers) {
          for (const s of specifiers.split(", ")) {
            if (!existing.includes(s)) existing.push(s);
          }
        } else if (specifiers) {
          seen.set(importPath, [specifiers]);
        } else {
          if (!seen.has(importPath)) seen.set(importPath, []);
        }
      }
      let count = 0;
      for (const [importPath, syms] of seen) {
        if (count >= 15) break;
        if (syms.length > 0) {
          lines.push(`  ${importPath} → ${syms.join(", ")}`);
        } else {
          lines.push(`  ${importPath}`);
        }
        count++;
      }
    }
  } catch { /* no matches */ }

  if (lines.length === 0) return "";
  const result = lines.join("\n");
  writeCache(cacheKey, result, DEFAULT_TTLS["import-graph"] ?? 30000);
  return result;
}

async function resolveExports(ctx: ResolverContext): Promise<string> {
  const file = ctx.targetFile;
  if (!file) return "";

  const cacheKey = `exports:${file}`;
  const cached = readCache(cacheKey);
  if (cached && cached.data) return cached.data;

  const ext = path.extname(file);
  const isTS = ext === ".ts" || ext === ".tsx";
  const isJS = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
  if (!isTS && !isJS) return "";

  const includeFlags = isTS
    ? ["--include=*.ts", "--include=*.tsx"]
    : ["--include=*.js", "--include=*.jsx", "--include=*.mjs"];

  const lines: string[] = [];

  try {
    const fileContent = fs.readFileSync(file, "utf-8");
    const fileLines = fileContent.split("\n");
    const exportLines: string[] = [];
    for (const fl of fileLines) {
      const trimmed = fl.trim();
      const sigMatch = trimmed.match(
        /^export (default |)(function |const |class |type |interface |enum |async function )[A-Za-z_]/
      );
      if (sigMatch) {
        const sig = trimmed
          .replace(/^export /, "")
          .replace(/;$/, "")
          .replace(/\{$/, "")
          .trim();
        const display = sig.length > 80 ? sig.slice(0, 77) + "..." : sig;
        exportLines.push(display);
        continue;
      }
      const namedMatch = trimmed.match(/^export\s+\{([^}]+)\}\s*(?:from\s+['"][^'"]+['"])?/);
      if (namedMatch) {
        const names = namedMatch[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
        exportLines.push(`{ ${names.join(", ")} }`);
        continue;
      }
      const reExportMatch = trimmed.match(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/);
      if (reExportMatch) {
        exportLines.push(`* from ${reExportMatch[1]}`);
        continue;
      }
      const typeReExportMatch = trimmed.match(/^export\s+type\s+\{([^}]+)\}\s*(?:from\s+['"][^'"]+['"])?/);
      if (typeReExportMatch) {
        const names = typeReExportMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
        exportLines.push(`type { ${names.join(", ")} }`);
      }
    }
    if (exportLines.length > 0) {
      lines.push("Exports:");
      for (const sig of exportLines.slice(0, 20)) {
        lines.push(`  ${sig}`);
      }
      if (exportLines.length > 20) lines.push(`  ... +${exportLines.length - 20} more`);
    }
  } catch { /* no file */ }

  try {
    const { stdout } = await execFileAsync(
      "grep",
      ["-oE", "process\\.env\\.[A-Za-z_][A-Za-z0-9_]*", ...includeFlags, file],
      { encoding: "utf-8", timeout: 5000 },
    );
    const envRefs = stdout.trim().split("\n").filter(Boolean);
    if (envRefs.length > 0) {
      const unique = [...new Set(envRefs.map((s) => s.replace(/.*process\.env\./, "")))];
      lines.push(`env refs: ${unique.join(", ")}`);
    }
  } catch { /* no matches */ }

  if (lines.length === 0) return "";
  const result = lines.join("\n");
  writeCache(cacheKey, result, DEFAULT_TTLS["exports"] ?? 30000);
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

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatNow(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const day = DAY_NAMES[date.getDay()];
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const tz = Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")?.value ?? "UTC";
  return `${y}-${mo}-${d} ${day} ${h}:${mi} ${tz}`;
}

async function resolveNow(ctx: ResolverContext): Promise<string> {
  const intervalMin = ctx.intervalMin ?? 5;
  const now = new Date();
  now.setMinutes(Math.floor(now.getMinutes() / intervalMin) * intervalMin, 0, 0);
  return formatNow(now);
}

async function resolveFileContent(ctx: ResolverContext): Promise<string> {
  const file = ctx.targetFile;
  if (!file) return "";
  const resolved = path.resolve(file);
  const cwd = process.cwd();
  if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
    log.warn(`resolveFileContent blocked path outside project root: ${file}`);
    return "";
  }
  const maxLines = ctx.maxLines ?? 60;
  try {
    if (!fs.existsSync(file)) return "";
    const stat = fs.statSync(file);
    if (stat.size > 20000) return `(file too large: ${(stat.size / 1024).toFixed(0)}KB)`;

    // C1 — mtime-aware cache: serve the previous render if the file hasn't
    // changed since. This is V10's #1 reward block (−58.8s); freshness is
    // the top signal. Re-reading + re-rendering on every resolve is wasteful
    // when the file hasn't changed.
    const cacheKey = `file-content:${file}`;
    const cached = readCache(cacheKey);
    if (cached?.data && cached.metadata?.mtime === String(stat.mtimeMs)) {
      return cached.data;
    }

    const rawContent = fs.readFileSync(file, "utf-8");

    // C1 — Signal density: collapse consecutive blank lines (max 1), trim
    // trailing whitespace per line. Removes visual noise that wastes tokens.
    const lines = rawContent.split("\n").map((l) => l.trimEnd());
    const denseLines: string[] = [];
    let prevBlank = false;
    for (const l of lines) {
      const isBlank = l.trim() === "";
      if (isBlank && prevBlank) continue;
      denseLines.push(l);
      prevBlank = isBlank;
    }

    let result: string;
    if (denseLines.length <= maxLines) {
      result = denseLines.join("\n");
    } else {
      // C1 — Smart truncation: show the head (imports/setup) + tail
      // (exports/close) with a collapsed middle. Fits more signal in the
      // budget than naive head-only truncation.
      const headLines = Math.ceil(maxLines * 0.6);
      const tailLines = maxLines - headLines;
      const head = denseLines.slice(0, headLines);
      const tail = denseLines.slice(denseLines.length - tailLines);
      const hidden = denseLines.length - headLines - tailLines;
      result = head.join("\n") + `\n... (${hidden} lines collapsed) ...\n` + tail.join("\n");
    }

    writeCache(cacheKey, result, 10_000, { mtime: String(stat.mtimeMs) });
    return result;
  } catch { return ""; }
}

export const RESOLVERS: Record<ContextSource, SourceResolver> = {
  "crew-status": resolveCrewStatus,
  "crew-locks": resolveCrewLocks,
  "file-errors": resolveValidation,
  "git-context": resolveGitContext,
  "git-delta": resolveGitDelta,
  "git-staged": resolveGitStaged,
  "git-diff-stat": resolveGitDiffStat,
  "edit-diff": resolveEditDiff,
  "syntax-check": resolveSyntaxCheck,
  "test-failures": resolveTestFailures,
  custom: resolveCustom,
  handoff: resolveHandoff,
  "import-graph": resolveImportGraph,
  "session-diff": resolveSessionDiff,
  "session-validate": resolveSessionValidate,
  "exports": resolveExports,
  "file-content": resolveFileContent,
  now: resolveNow,
};

const ESLINT_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);
const POST_EDIT_LINT_TIMEOUT_MS = 4000;
const VALIDATOR_TIMEOUT_MS = 10_000;
const VALIDATOR_MAX_LINES = 15;
const _binAvailable = new Map<string, boolean>();

function commandAvailable(bin: string): boolean {
  const cached = _binAvailable.get(bin);
  if (cached !== undefined) return cached;
  let ok = true;
  try {
    execFileSync("sh", ["-c", `command -v ${bin} >/dev/null 2>&1`], { stdio: "ignore" });
  } catch { ok = false; }
  _binAvailable.set(bin, ok);
  return ok;
}

interface FileValidator {
  bin: string;
  args: string[];
  format: (code: number, stdout: string) => string;
}

// Picks the per-file validator for the file's ecosystem. Returns null when no
// validator applies (unknown extension, or the toolchain isn't on PATH) — the
// caller then suppresses rather than running a wrong tool (e.g. eslint on a .go
// file, which previously leaked "File ignored… no matching configuration").
function pickValidator(filePath: string): FileValidator | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ESLINT_EXTS.has(ext)) {
    return { bin: "npx", args: ["eslint", filePath, "--no-color"], format: (_c, stdout) => stdout.trim() };
  }
  if (ext === ".py" && commandAvailable("ruff")) {
    return { bin: "ruff", args: ["check", "--no-cache", filePath], format: (code, stdout) => (code !== 0 ? stdout.trim() : "") };
  }
  if (ext === ".go" && commandAvailable("go")) {
    return { bin: "gofmt", args: ["-l", filePath], format: (_c, stdout) => (stdout.trim() ? `${filePath}: needs gofmt` : "") };
  }
  if (ext === ".lua" && commandAvailable("luacheck")) {
    return { bin: "luacheck", args: ["--no-config", filePath], format: (code, stdout) => (code !== 0 ? stdout.trim() : "") };
  }
  return null;
}

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

  const applicableRules = rules.filter((rule) => {
    if (rule.scope === "target-file" && !targetFile) return false;
    if (sourceFilter && !sourceFilter.has(rule.source)) return false;
    if (!topologyAllows(rule.source, targetFile)) return false;
    return true;
  });

  const resolverStart = Date.now()

  const resolveWithTimeout = async (
    rule: InjectionRule,
  ): Promise<{ rule: InjectionRule; content: string | null }> => {
    const ctx: ResolverContext = {
      trigger,
      targetFile,
      sessionId: effectiveSessionId,
      config,
      intervalMin: rule["interval-min"],
      maxLines: rule["max-lines"],
    };
    const resolver = RESOLVERS[rule.source];
    if (!resolver) return { rule, content: null };

    const timeout = Math.min(RESOLVER_PER_ITEM_MS, Math.max(500, RESOLVER_TOTAL_BUDGET_MS - (Date.now() - resolverStart)));

    try {
      const content = await Promise.race([
        resolver(ctx),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), timeout),
        ),
      ]);
      return { rule, content };
    } catch (err: unknown) {
      log.debug(`resolver ${rule.source} failed: ${errMsg(err)}`);
      if (verbose) {
        process.stderr.write(`[pmd:inject] resolver ${rule.source} error: ${errMsg(err)}\n`);
      }
      return { rule, content: null };
    }
  };

  const results = await Promise.allSettled(applicableRules.map((r) => resolveWithTimeout(r)));

  const payloads: InjectionPayload[] = []
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { rule, content } = result.value;
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
  const guardKey = `validation:running:${filePath}`;
  if (isFresh(guardKey)) return;
  writeCache(guardKey, "1", VALIDATION_COOLDOWN_MS);

  const validator = pickValidator(filePath);
  if (!validator) {
    // No validator for this file type / toolchain — drop any stale entry from a
    // previous toolchain and release the guard rather than running a wrong tool.
    invalidate(cacheKey);
    invalidate(guardKey);
    return;
  }

  try {
    let result = "";
    try {
      const { stdout } = await execFileAsync(validator.bin, validator.args, {
        encoding: "utf-8",
        timeout: VALIDATOR_TIMEOUT_MS,
      });
      result = validator.format(0, stdout);
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; code?: number };
      const stdout = typeof execErr.stdout === "string" ? execErr.stdout : "";
      result = validator.format(execErr.code ?? 1, stdout);
    }
    const content = result
      ? result.split("\n").slice(0, VALIDATOR_MAX_LINES).join("\n")
      : "No errors found";
    // Snapshot the file's mtime so the reader can detect post-validation edits
    // by comparing the same clock (statSync mtimeMs) before/after — Date.now()
    // vs mtimeMs cross-clock jitter would otherwise flag fresh entries as stale.
    let mtimeMeta: Record<string, string> | undefined;
    try { mtimeMeta = { mtime: String(fs.statSync(filePath).mtimeMs) }; } catch { /* file gone */ }
    writeCache(cacheKey, content, DEFAULT_TTLS.validation ?? 60000, mtimeMeta);
  } catch (err: unknown) {
    log.debug(`validation failed for ${filePath}: ${errMsg(err)}`);
  } finally {
    invalidate(guardKey);
  }
}
