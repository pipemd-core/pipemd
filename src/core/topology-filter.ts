import path from "node:path";

/**
 * V15 — Topology filter: deterministic per-block file-type gates.
 *
 * This is V7's 15× label-spread signal (CDC docs/ml-v7-cdc.md §12) turned
 * into a hard filter. Before resolving a rule, the adaptive decision checks
 * `topologyAllows(rule.source, targetFile)` and skips the rule entirely when
 * the source cannot produce meaningful content for that file type. The
 * resolver implementations already short-circuit internally (returning ""),
 * but applying the gate at rule-selection time means:
 *
 *   - the resolver never runs (saves the timeout budget per trigger),
 *   - the BOOST logic never tries to force-fire an impossible block,
 *   - the V7 "labels spread 15× by file role" finding is honored as config.
 *
 * Zero ML — this is a pure extension map.
 */

const TYPEABLE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts",
]);

/** Lintable: ESLint for JS/TS; ruff/gofmt/luacheck resolve themselves. */
const LINTABLE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".lua",
]);

/** Static assets and prose — never type-checkable, never lint-relevant. */
const PROSE_EXTS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini",
  ".css", ".html", ".svg", ".png", ".jpg", ".jpeg", ".gif",
  ".lock", ".log",
]);

export type TopologySource =
  | "syntax-check"
  | "file-errors"
  | "import-graph"
  | "exports"
  | "edit-diff"
  | "git-context"
  | "git-delta"
  | "git-staged"
  | "git-diff-stat"
  | "test-failures"
  | "crew-status"
  | "crew-locks"
  | "session-diff"
  | "session-validate"
  | "handoff"
  | "file-content"
  | "custom"
  | "now";

/**
 * True iff `source` can produce useful content for `targetFile`.
 *
 * File-type gates (V7 §12 — labels spread 15× by file role):
 *   - `import-graph` / `exports`: JS/TS only (the resolver greps `from '..'`).
 *   - `syntax-check`: typeable files only (tsc / type-aware tools).
 *   - `file-errors`: lintable files (eslint / ruff / gofmt / luacheck).
 *   - everything else: file-content-agnostic, always allowed.
 *
 * `undefined` or empty `targetFile` → allow (global rules / no target context).
 */
export function topologyAllows(source: TopologySource, targetFile?: string): boolean {
  if (!targetFile || targetFile === "") return true;
  const ext = path.extname(targetFile).toLowerCase();

  switch (source) {
    case "import-graph":
    case "exports":
      return ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx"
        || ext === ".mjs" || ext === ".cjs";
    case "syntax-check":
      return TYPEABLE_EXTS.has(ext);
    case "file-errors":
      return LINTABLE_EXTS.has(ext);
    case "edit-diff":
    case "git-context":
    case "git-delta":
    case "git-staged":
    case "git-diff-stat":
    case "test-failures":
    case "crew-status":
    case "crew-locks":
    case "session-diff":
    case "session-validate":
    case "handoff":
    case "file-content":
    case "custom":
    case "now":
      return true;
    default:
      return true;
  }
}

/** Test helper: is `ext` considered prose / static (never injectable)? */
export function isProseExt(ext: string): boolean {
  return PROSE_EXTS.has(ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`);
}
