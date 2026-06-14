#!/usr/bin/env node
// repomap.mjs — Ranked signature map with personalized PageRank
// Produces a token-budgeted overview of the most important symbols in the codebase,
// ranked by reference-graph centrality and git recency.
//
// Environment variables (set by repomap.sh):
//   PMD_SG          Path to ast-grep binary (empty = regex fallback)
//   PMD_ECOSYSTEM   Detected ecosystem (Node-TypeScript, Python, Generic, etc.)
//   PMD_MAX_REPOMAP Maximum output lines (default: 60)
//   PMD_REPOMAP_SINCE  Git recency window (default: "2 weeks ago")

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SG = process.env.PMD_SG || "";
const ECOSYSTEM = process.env.PMD_ECOSYSTEM || "";
const MAX_LINES = parseInt(process.env.PMD_MAX_REPOMAP || "60", 10);
const GIT_SINCE = process.env.PMD_REPOMAP_SINCE || "2 weeks ago";

// ── Skip patterns ──
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".next", "coverage", "build", "out", ".pipemd",
  ".git", "__pycache__", "__tests__", "__test__", "__mocks__", "test",
  "tests", "spec", "specs", "scripts", "migrations", "seed", "public",
  "static", "assets", "styles", "views", "templates", ".angular", ".cache",
  ".storybook", ".venv", ".tox", "vendor", ".opencode",
]);
const SKIP_SUFFIXES = [".d.ts", ".test.ts", ".test.tsx", ".test.js", ".test.jsx",
  ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx", ".stories.tsx", ".stories.ts"];

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

function shouldSkipFile(name) {
  if (SKIP_SUFFIXES.some(s => name.endsWith(s))) return true;
  if (name.endsWith(".map")) return true;
  if (name.endsWith(".min.js")) return true;
  return false;
}

// ── Source extensions per ecosystem ──
function getSourceExts() {
  switch (ECOSYSTEM) {
    case "Node-TypeScript": return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
    case "Python": return [".py"];
    case "Rust": return [".rs"];
    case "Go": return [".go"];
    case "C-CPP": return [".c", ".cpp", ".cc", ".h", ".hpp"];
    default: return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".lua", ".c", ".cpp", ".cc", ".h", ".hpp"];
  }
}

function getAstGrepLang(ext) {
  const map = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
    ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".c": "c", ".cpp": "cpp", ".cc": "cpp", ".h": "c", ".hpp": "cpp",
  };
  return map[ext] || null;
}

// ── File discovery ──
function discoverFiles(rootDirs, exts, maxFiles = 500) {
  const files = [];

  function walk(dir) {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        if (shouldSkipFile(entry.name)) continue;
        const ext = path.extname(entry.name);
        if (!exts.includes(ext)) continue;
        files.push(path.relative(process.cwd(), fullPath));
      }
    }
  }

  for (const dir of rootDirs) {
    if (fs.existsSync(dir)) walk(dir);
  }

  return files.sort();
}

function detectRootDirs() {
  const candidates = ["src", "lib", "app", "server", "api"];
  const found = candidates.filter(d => fs.existsSync(d));
  if (found.length > 0) return found;
  return ["."];
}

// ── Definition extraction ──

const SG_PATTERNS = [
  { pattern: "function $NAME($$$ARGS) { $$$ }", kind: "fn" },
  { pattern: "async function $NAME($$$ARGS) { $$$BODY }", kind: "fn" },
  { pattern: "class $NAME $$$REST", kind: "class" },
  { pattern: "interface $NAME { $$$ }", kind: "iface" },
  { pattern: "type $NAME = $$$", kind: "type" },
];

const REGEX_PATTERNS = [
  // TS/JS exported definitions
  { regex: /^export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/m, kind: "fn" },
  { regex: /^export\s+(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/m, kind: "class" },
  { regex: /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/m, kind: "class" },
  { regex: /^export\s+(?:type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/m, kind: "type" },
  { regex: /^export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)/m, kind: "const" },
  // TS/JS non-exported top-level
  { regex: /^(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/m, kind: "fn" },
  { regex: /^class\s+([A-Za-z_$][A-Za-z0-9_$]*)/m, kind: "class" },
  { regex: /^(?:type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/m, kind: "type" },
  // Python
  { regex: /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/m, kind: "fn" },
  { regex: /^class\s+([A-Za-z_][A-Za-z0-9_]*)/m, kind: "class" },
  // Rust
  { regex: /^(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/m, kind: "fn" },
  { regex: /^(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/m, kind: "struct" },
  { regex: /^(?:pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/m, kind: "enum" },
  { regex: /^(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/m, kind: "trait" },
  // Go
  { regex: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_][A-Za-z0-9_]*)/m, kind: "fn" },
  { regex: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/m, kind: "type" },
  // Lua
  { regex: /^(?:local\s+)?function\s+([A-Za-z_][A-Za-z0-9_.]*)/m, kind: "fn" },
];

function extractDefinitionsSG(files) {
  const results = new Map();

  const langGroups = new Map();
  for (const file of files) {
    const ext = path.extname(file);
    const lang = getAstGrepLang(ext);
    if (!lang) continue;
    if (!langGroups.has(lang)) langGroups.set(lang, []);
    langGroups.get(lang).push(file);
  }

  for (const [lang, langFiles] of langGroups) {
    const applicablePatterns = SG_PATTERNS.filter(p => {
      if (["typescript", "tsx", "javascript", "jsx"].includes(lang)) {
        return ["fn", "class", "iface", "type"].includes(p.kind);
      }
      if (lang === "python") {
        return p.kind === "fn" || p.kind === "class";
      }
      if (lang === "rust") {
        return p.kind === "fn" || p.kind === "class";
      }
      return false;
    });

    for (const { pattern, kind } of applicablePatterns) {
      let raw;
      try {
        raw = execFileSync(SG, ["-p", pattern, "-l", lang, "--json", ...langFiles], {
          encoding: "utf-8",
          timeout: 10000,
          maxBuffer: 10 * 1024 * 1024,
          stdio: ["pipe", "pipe", "ignore"],
        });
      } catch {
        continue;
      }
      let matches;
      try {
        matches = JSON.parse(raw);
      } catch {
        continue;
      }
      const seenInFile = new Set();
      for (const m of matches) {
        const name = m.metaVariables?.single?.NAME?.text;
        if (!name) continue;
        const file = m.file || "";
        const dedupKey = `${file}:${name}`;
        if (seenInFile.has(dedupKey)) continue;
        seenInFile.add(dedupKey);
        const line = m.range?.start?.line ?? 0;
        const col = m.range?.start?.column ?? 0;
        if (!results.has(file)) results.set(file, []);
        const sigLine = (m.lines || "").split("\n")[0].trim().slice(0, 100);
        const isExported = sigLine.startsWith("export ");
        results.get(file).push({ name, kind, isExported, line, col, sig: sigLine });
      }
    }
  }

  return results;
}

function extractDefinitionsRegex(files) {
  const results = new Map();
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0 || line[0] === " " || line[0] === "\t" || line[0] === "*" || line.startsWith("//") || line.startsWith("#") && !line.startsWith("#!")) continue;
      for (const { regex, kind } of REGEX_PATTERNS) {
        const m = line.match(regex);
        if (!m) continue;
        const name = m[1];
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const isExported = line.includes("export ") || line.includes("pub ");
        if (!results.has(file)) results.set(file, []);
        let sig = line.trim().slice(0, 80);
        if (sig.length >= 80) sig = sig.slice(0, 77) + "...";
        results.get(file).push({ name, kind, isExported, line: i, col: 0, sig });
        break;
      }
    }
  }
  return results;
}

function extractDefinitions(files) {
  if (SG && fs.existsSync(SG)) {
    const sgResults = extractDefinitionsSG(files);
    const covered = new Set();
    for (const f of sgResults.keys()) covered.add(f);
    const uncovered = files.filter(f => !covered.has(f));
    if (uncovered.length > 0) {
      const regexResults = extractDefinitionsRegex(uncovered);
      for (const [file, syms] of regexResults) sgResults.set(file, syms);
    }
    return sgResults;
  }
  return extractDefinitionsRegex(files);
}

// ── Reference extraction (imports) ──

const IMPORT_REGEXES = [
  // TS/JS: import ... from './path' or require('./path')
  /(?:import\s+.*?\s+from\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g,
  // Python: from module import ... or import module
  /^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/gm,
  // Rust: use crate::module or use module
  /^\s*use\s+(\S+)/gm,
  // Go: import "path" or import multi-line
  /^\s*"([^"]+)"/gm,
  // Lua: require("path") or require 'path'
  /require\s*[\('"]\s*([\w./-]+)\s*[\)'"]/g,
];

function extractReferences(files) {
  const refs = new Map(); // file → [{target, resolved}]

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const fileDir = path.dirname(file);
    const ext = path.extname(file);
    const edges = [];

    for (const regex of IMPORT_REGEXES) {
      let m;
      regex.lastIndex = 0;
      while ((m = regex.exec(content)) !== null) {
        const importPath = m[1] || m[2];
        if (!importPath) continue;

        if (importPath.startsWith(".")) {
          const resolved = path.posix.normalize(path.posix.join(fileDir, importPath));
          edges.push(resolved);
        }
      }
    }

    if (edges.length > 0) refs.set(file, edges);
  }

  return refs;
}

function resolveToFiles(refs, files) {
  const fileSet = new Set(files);
  const resolved = new Map(); // file → Set<targetFile>

  const candidates = (base) => {
    const results = [];
    for (const ext of getSourceExts()) {
      results.push(base + ext);
    }
    results.push(base);
    if (!base.endsWith("/index")) {
      for (const ext of getSourceExts()) {
        results.push(base + "/index" + ext);
      }
    }
    return results;
  };

  for (const [file, edges] of refs) {
    const targets = new Set();
    for (const edge of edges) {
      const base = edge.replace(/\.\w+$/, "");
      for (const candidate of candidates(base)) {
        if (fileSet.has(candidate)) {
          targets.add(candidate);
          break;
        }
      }
    }
    if (targets.size > 0) resolved.set(file, targets);
  }

  return resolved;
}

// ── Git recency ──
function getGitRecency() {
  let raw;
  try {
    raw = execFileSync("git", ["log", `--since=${GIT_SINCE}`, "--name-only", "--format="], {
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    return new Map();
  }

  const recency = new Map();
  const counts = new Map();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    counts.set(trimmed, (counts.get(trimmed) || 0) + 1);
  }

  let maxCount = 1;
  for (const c of counts.values()) if (c > maxCount) maxCount = c;

  for (const [file, count] of counts) {
    recency.set(file, count / maxCount);
  }

  return recency;
}

// ── Personalized PageRank ──
function pageRank(nodes, incoming, outgoing, personalization, damping = 0.85, iterations = 20) {
  const n = nodes.length;
  if (n === 0) return new Map();

  let scores = new Map();
  let persSum = 0;
  for (const node of nodes) {
    const p = personalization.get(node) || 0.01;
    scores.set(node, p);
    persSum += p;
  }
  if (persSum === 0) {
    for (const node of nodes) scores.set(node, 1 / n);
    persSum = 1;
  }
  for (const [node, s] of scores) scores.set(node, s / persSum);

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map();
    let danglingSum = 0;

    for (const node of nodes) {
      const out = outgoing.get(node);
      if (!out || out.size === 0) {
        danglingSum += scores.get(node) || 0;
      }
    }

    for (const node of nodes) {
      let rank = (1 - damping) * ((personalization.get(node) || 0.01) / persSum);
      rank += damping * (danglingSum / n);

      const inc = incoming.get(node);
      if (inc) {
        for (const src of inc) {
          const srcScore = scores.get(src) || 0;
          const srcOut = outgoing.get(src);
          const outDeg = srcOut ? srcOut.size : 1;
          rank += damping * (srcScore / outDeg);
        }
      }

      next.set(node, rank);
    }

    scores = next;
  }

  return scores;
}

// ── Tribal knowledge (Phase 2) ──
function extractTribalKnowledge(files) {
  const results = new Map(); // file → [{line, text, type}]

  const isComment = (line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("//") || trimmed.startsWith("*") ||
           trimmed.startsWith("/*") || trimmed.startsWith("#") ||
           trimmed.startsWith("--");
  };

  const extractCommentText = (line) => {
    return line.replace(/^\s*(?:\/\/|\/\*|\*|#|--)\s*/, "").trim();
  };

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    const notes = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isComment(line)) {
        const inlineIdx = Math.max(line.indexOf("//"), line.indexOf("# "));
        if (inlineIdx === -1) continue;
        const commentPart = line.slice(inlineIdx);
        const m = commentPart.match(/\b(FIXME|HACK|TODO|XXX|BUG|WORKAROUND)\b/);
        if (m) {
          notes.push({ line: i, text: commentPart.trim().slice(0, 100), type: m[1] });
        }
        continue;
      }

      const commentText = extractCommentText(line);
      let m;
      if ((m = commentText.match(/\b(FIXME|HACK|TODO|XXX|BUG|WORKAROUND)\b/))) {
        notes.push({ line: i, text: commentText.slice(0, 100), type: m[1] });
        continue;
      }
      if (/\b(seems buggy|do not|broken|deprecated|hot path|performance critical|side effect)\b/i.test(commentText)) {
        notes.push({ line: i, text: commentText.slice(0, 100), type: "warn" });
      }
    }

    if (notes.length > 0) results.set(file, notes);
  }

  return results;
}

// ── Signature elision ──
function elideSignature(sig) {
  let s = sig
    .replace(/^export\s+/, "")
    .replace(/^async\s+/, "")
    .replace(/^default\s+/, "")
    .replace(/^abstract\s+/, "")
    .replace(/^public\s+/, "")
    .replace(/^private\s+/, "")
    .replace(/^pub\s+/, "");

  if (s.startsWith("type ") || s.startsWith("interface ")) {
    const m = s.match(/^(type|interface)\s+(\w+)/);
    if (m) return m[1][0] + ":" + m[2];
  }
  if (s.startsWith("enum ")) {
    const m = s.match(/^enum\s+(\w+)/);
    if (m) return "e:" + m[1];
  }
  if (s.startsWith("struct ")) {
    const m = s.match(/^struct\s+(\w+)/);
    if (m) return "s:" + m[1];
  }
  if (s.startsWith("trait ")) {
    const m = s.match(/^trait\s+(\w+)/);
    if (m) return "r:" + m[1];
  }
  if (s.startsWith("class ")) {
    const m = s.match(/^class\s+(\w+)/);
    if (m) return "c:" + m[1];
  }

  if (s.startsWith("const ") || s.startsWith("let ") || s.startsWith("var ")) {
    const constMatch = s.match(/^(?:const|let|var)\s+(\w+)/);
    if (constMatch) return constMatch[1];
  }

  // Functions: keep name + param names, strip types and generics
  const parenIdx = s.indexOf("(");
  if (parenIdx > 0) {
    let namePart = s.slice(0, parenIdx).trim();
    namePart = namePart.replace(/<.*>/s, "").trim();
    const nameMatch = namePart.match(/(\w+)$/);
    if (nameMatch) {
      const name = nameMatch[1];
      const paramsStr = s.slice(parenIdx + 1).split(")")[0];
      const params = paramsStr
        .split(",")
        .map(p => {
          const pm = p.trim().match(/^(\w+|\{|\[|\.\.\.)/);
          return pm ? pm[1] : "?";
        })
        .filter(p => p && p !== "?")
        .join(", ");
      return `${name}(${params})`;
    }
  }

  return s.replace(/\s+/g, " ").trim().slice(0, 50);
}

function kindAbbrev(kind) {
  return "";
}

// ── Rendering ──
function render(files, defs, ranks, resolvedRefs, tribal, maxLines) {
  const ranked = files
    .map(f => ({ file: f, rank: ranks.get(f) || 0 }))
    .sort((a, b) => b.rank - a.rank);

  const maxRank = ranked.length > 0 ? ranked[0].rank : 1;

  const incomingCache = new Map();
  for (const file of files) {
    incomingCache.set(file, []);
  }
  for (const [src, targets] of resolvedRefs) {
    for (const tgt of targets) {
      incomingCache.get(tgt)?.push(src);
    }
  }

  const lines = [];
  const shownFiles = new Set();
  let lineBudget = maxLines;

  for (const { file, rank } of ranked) {
    if (lineBudget <= 0) break;
    const syms = defs.get(file);
    if (!syms || syms.length === 0) continue;

    const exported = syms.filter(s => s.isExported);
    const top = (exported.length > 0 ? exported : syms).slice(0, 8);

    const symStrs = top.map(s => elideSignature(s.sig));

    const rankRatio = maxRank > 0 ? rank / maxRank : 0;
    const rankBar = rankRatio > 0.7 ? "★★★" : rankRatio > 0.4 ? "★★" : rankRatio > 0.1 ? "★" : "";
    lines.push(`${file} ${rankBar}`);
    lines.push(`  ${symStrs.join(", ")}`);

    shownFiles.add(file);
    lineBudget -= 2;

    if (shownFiles.size <= 10 && lineBudget > 0) {
      const out = resolvedRefs.get(file);
      if (out && out.size > 0) {
        const outRanked = [...out]
          .map(f => ({ f, r: ranks.get(f) || 0 }))
          .sort((a, b) => b.r - a.r)
          .slice(0, 3)
          .map(x => x.f);
        if (outRanked.length > 0) {
          lines.push(`  → ${outRanked.join(", ")}`);
          lineBudget--;
        }
      }

      const inc = incomingCache.get(file) || [];
      if (inc.length > 0) {
        const incRanked = inc
          .map(f => ({ f, r: ranks.get(f) || 0 }))
          .sort((a, b) => b.r - a.r)
          .slice(0, 3)
          .map(x => x.f);
        lines.push(`  ← ${incRanked.join(", ")}`);
        lineBudget--;
      }
    }

    const notes = tribal.get(file);
    if (notes && shownFiles.size <= 10 && lineBudget > 0) {
      for (const note of notes.slice(0, 2)) {
        if (lineBudget <= 0) break;
        const tag = note.type === "warn" ? "⚠" : note.type;
        lines.push(`  ${tag} ${note.text}`);
        lineBudget--;
      }
    }
  }

  if (lines.length === 0) return "No symbols found";

  const totalSyms = [...defs.values()].reduce((sum, syms) => sum + syms.length, 0);
  lines.push("");
  lines.push(`*${shownFiles.size} files, ${totalSyms} symbols — ranked by PageRank × git recency*`);

  return lines.join("\n");
}

// ── Main ──
function main() {
  const rootDirs = detectRootDirs();
  const exts = getSourceExts();
  const files = discoverFiles(rootDirs, exts);

  if (files.length === 0) {
    console.log("No source files found");
    return;
  }

  const defs = extractDefinitions(files);
  const refs = extractReferences(files);
  const resolvedRefs = resolveToFiles(refs, files);
  const recency = getGitRecency();

  // Build graph
  const incoming = new Map(); // file → Set<file>
  const outgoing = new Map();  // file → Set<file>
  for (const file of files) {
    incoming.set(file, new Set());
    outgoing.set(file, new Set());
  }
  for (const [src, targets] of resolvedRefs) {
    for (const tgt of targets) {
      outgoing.get(src)?.add(tgt);
      incoming.get(tgt)?.add(src);
    }
  }

  // Personalization: git recency + definition count (more symbols = more important)
  const personalization = new Map();
  for (const file of files) {
    const rec = recency.get(file) || 0;
    const symCount = defs.get(file)?.length || 0;
    const symWeight = Math.min(symCount / 10, 1);
    personalization.set(file, 0.05 + rec * 0.8 + symWeight * 0.15);
  }

  const ranks = pageRank(files, incoming, outgoing, personalization);

  // Phase 2: Tribal knowledge
  const tribal = extractTribalKnowledge(files);

  // Render
  const output = render(files, defs, ranks, resolvedRefs, tribal, MAX_LINES);
  console.log(output);
}

main();
