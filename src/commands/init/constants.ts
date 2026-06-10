import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Ecosystem } from "../../core/detect.js";
import type { HarnessName } from "../../core/detectHarness.js";
import type { TokenProfile } from "../../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_ROOT = path.join(__dirname, "..", "scripts");
export const TEMPLATES_ROOT = path.join(__dirname, "..", "templates");

export function loadTemplate(name: string): string {
  return fs.readFileSync(path.join(TEMPLATES_ROOT, name), "utf8").trimEnd();
}

export type AiAgent = "Claude Code" | "Cursor" | "Aider" | "Gemini" | "Generic" | "OpenClaw" | "Hermes";
export type Harness = "OpenCode" | "Claude Code" | "Cursor" | "Gemini" | "None" | "OpenClaw" | "Hermes";

export interface ScriptDef {
  id: string;
  label: string;
  description: string;
  command: string;
  category: "project" | "git" | "quality" | "db" | "api" | "frontend" | "cpp" | "rust" | "go" | "devops" | "architecture";
  volatile: number;
  file: string;
}

export interface RunResult {
  id: string;
  status: "success" | "error" | "empty" | "timeout";
  stdout: string;
  stderr: string;
  lines: number;
}

export const AGENT_CLI: Record<string, string[]> = {
  "Claude Code": ["claude"],
  "Cursor": ["cursor-agent"],
  "Aider": ["aider"],
  "Gemini": ["gemini"],
  "OpenClaw": ["openclaw"],
  "Hermes": ["hermes"],
};

export const HARNESS_CLI: Record<string, string[]> = {
  "OpenCode": ["opencode"],
  "Claude Code": ["claude"],
  "Cursor": ["cursor-agent"],
  "Gemini": ["gemini"],
  "OpenClaw": ["openclaw"],
  "Hermes": ["hermes"],
};

export const TEST_RUN_TIMEOUT_MS = 5000;
export const TOKENS_PER_LINE = 15;

export const TOKEN_PROFILES: Record<TokenProfile, { num: number; den: number; label: string; description: string }> = {
  low:       { num: 1, den: 2, label: "Low",       description: "~3K tokens — minimal, compact context" },
  medium:    { num: 1, den: 1, label: "Medium",    description: "~6K tokens — balanced (default)" },
  high:      { num: 3, den: 2, label: "High",      description: "~9K tokens — detailed context" },
  xhigh:     { num: 2, den: 1, label: "XHigh",     description: "~12K tokens — maximum detail" },
  unlimited: { num: 0, den: 1, label: "Unlimited", description: "No token limit — full script output" },
};

export const SCRIPT_MAX_LINES: Record<string, number> = {
  arch: 100, compose: 150, tree: 50, deps: 40, todos: 20, exports: 30, "git-log": 20, "git-branch": 20,
  "git-status": 30, "diff-stat": 30, "type-check": 30, lint: 20,
  "test-summary": 10, prisma: 40, "express-routes": 30, "fastapi-routes": 30,
  "django-models": 40, sqlalchemy: 40, "nest-controllers": 30,
  "nextjs-app-router": 30, "react-components": 30, "angular-routes": 30, "angular-structure": 40,
  "cmake-targets": 40, "class-diagram": 40, interfaces: 30, "include-graph": 40,
  "cargo-deps": 40, "cargo-features": 20, "go-packages": 40, "go-interfaces": 30,
  "docker-stats": 30, "k8s-unhealthy": 20, "tf-state": 40, "aws-context": 10,
  crew: 40, "workspace-map": 60, "django-urls": 40, hotspots: 15, now: 1,
};

export const SCRIPT_LIBRARY: Record<string, ScriptDef[]> = {
  architecture: [
    { id: "arch", label: "Architecture Map", description: "Module dependency graph (Mermaid)", command: "bash .pipemd/scripts/architecture/arch.sh", category: "architecture", volatile: 1, file: "architecture/arch.sh" },
  ],
  project: [
    { id: "compose", label: "Project Docs", description: "Assemble README.md and docs from sub-projects", command: "bash .pipemd/scripts/project/compose-md.sh", category: "project", volatile: 1, file: "project/compose-md.sh" },
    { id: "tree", label: "Project Tree", description: "Directory structure (compact, depth-limited)", command: "bash .pipemd/scripts/project/tree.sh", category: "project", volatile: 1, file: "project/tree.sh" },
    { id: "deps", label: "Dependencies", description: "Direct production dependencies and versions", command: "bash .pipemd/scripts/project/deps.sh", category: "project", volatile: 1, file: "project/deps.sh" },
    { id: "todos", label: "TODOs / FIXMEs", description: "TODO, FIXME, HACK comments in source", command: "bash .pipemd/scripts/project/find-todos.sh", category: "project", volatile: 2, file: "project/find-todos.sh" },
    { id: "exports", label: "Exports & Env", description: "Exported symbols per module + env var references", command: "bash .pipemd/scripts/project/exports.sh", category: "project", volatile: 1, file: "project/exports.sh" },
    { id: "workspace-map", label: "Workspace Map", description: "Monorepo workspace members and inter-package dependencies", command: "bash .pipemd/scripts/project/workspace-map.sh", category: "project", volatile: 1, file: "project/workspace-map.sh" },
  ],
  git: [
    { id: "git-log", label: "Recent Commits", description: "Last 10 commits (hash, date, message)", command: "bash .pipemd/scripts/git/git-log.sh", category: "git", volatile: 2, file: "git/git-log.sh" },
    { id: "git-branch", label: "Branch & Tracking", description: "Current branch, upstream, ahead/behind", command: "bash .pipemd/scripts/git/git-branch.sh", category: "git", volatile: 2, file: "git/git-branch.sh" },
    { id: "git-status", label: "Git Status", description: "Changed, staged, and untracked files", command: "bash .pipemd/scripts/git/git-status.sh", category: "git", volatile: 3, file: "git/git-status.sh" },
    { id: "diff-stat", label: "Diff Stats", description: "File change summary (additions/deletions)", command: "bash .pipemd/scripts/git/diff-stat.sh", category: "git", volatile: 4, file: "git/diff-stat.sh" },
    { id: "hotspots", label: "Churn Hotspots", description: "Files with highest change frequency and churn volume", command: "bash .pipemd/scripts/git/hotspots.sh", category: "git", volatile: 2, file: "git/hotspots.sh" },
  ],
  quality: [
    { id: "type-check", label: "Type Errors", description: "Static type errors (tsc, mypy, etc.)", command: "bash .pipemd/scripts/quality/type-check.sh", category: "quality", volatile: 2, file: "quality/type-check.sh" },
    { id: "lint", label: "Lint Errors", description: "Linting errors (ESLint, Ruff, etc.)", command: "bash .pipemd/scripts/quality/lint.sh", category: "quality", volatile: 2, file: "quality/lint.sh" },
    { id: "test-summary", label: "Test Summary", description: "Pass/fail/skip counts (not full output)", command: "bash .pipemd/scripts/quality/test-summary.sh", category: "quality", volatile: 2, file: "quality/test-summary.sh" },
  ],
  db: [
    { id: "prisma", label: "Prisma Models", description: "Model names, field counts, and enums", command: "bash .pipemd/scripts/db/prisma.sh", category: "db", volatile: 1, file: "db/prisma.sh" },
    { id: "django-models", label: "Django Models", description: "Django model classes and fields", command: "bash .pipemd/scripts/db/django-models.sh", category: "db", volatile: 1, file: "db/django-models.sh" },
    { id: "sqlalchemy", label: "SQLAlchemy Models", description: "SQLAlchemy model signatures and tables", command: "bash .pipemd/scripts/db/sqlalchemy.sh", category: "db", volatile: 1, file: "db/sqlalchemy.sh" },
  ],
  api: [
    { id: "express-routes", label: "Express Routes", description: "Express route method + path signatures", command: "bash .pipemd/scripts/api/express-routes.sh", category: "api", volatile: 1, file: "api/express-routes.sh" },
    { id: "fastapi-routes", label: "FastAPI Routes", description: "FastAPI endpoint signatures", command: "bash .pipemd/scripts/api/fastapi-routes.sh", category: "api", volatile: 1, file: "api/fastapi-routes.sh" },
    { id: "nest-controllers", label: "NestJS Controllers", description: "NestJS controller decorators and routes", command: "bash .pipemd/scripts/api/nest-controllers.sh", category: "api", volatile: 1, file: "api/nest-controllers.sh" },
    { id: "django-urls", label: "Django URLs", description: "Django URL patterns from urls.py files", command: "bash .pipemd/scripts/api/django-urls.sh", category: "api", volatile: 1, file: "api/django-urls.sh" },
  ],
  frontend: [
    { id: "nextjs-app-router", label: "Next.js Routes", description: "App Router route tree from page.tsx files", command: "bash .pipemd/scripts/frontend/nextjs-app-router.sh", category: "frontend", volatile: 1, file: "frontend/nextjs-app-router.sh" },
    { id: "react-components", label: "React Components", description: "Exported function components and Props types", command: "bash .pipemd/scripts/frontend/react-components.sh", category: "frontend", volatile: 1, file: "frontend/react-components.sh" },
    { id: "angular-routes", label: "Angular Routes", description: "Angular route definitions (routing modules + standalone routes)", command: "bash .pipemd/scripts/frontend/angular-routes.sh", category: "frontend", volatile: 1, file: "frontend/angular-routes.sh" },
    { id: "angular-structure", label: "Angular Structure", description: "Routes, components, services, module type, key directories", command: "bash .pipemd/scripts/frontend/angular-structure.sh", category: "frontend", volatile: 1, file: "frontend/angular-structure.sh" },
  ],
  cpp: [
    { id: "cmake-targets", label: "CMake Targets", description: "CMake executables, libraries, and link dependencies", command: "bash .pipemd/scripts/project/cmake-targets.sh", category: "cpp", volatile: 1, file: "project/cmake-targets.sh" },
    { id: "class-diagram", label: "Class Diagram", description: "Mermaid classDiagram from C++ headers and inheritance", command: "bash .pipemd/scripts/project/class-diagram.sh", category: "cpp", volatile: 1, file: "project/class-diagram.sh" },
    { id: "interfaces", label: "C++ Interfaces", description: "Pure virtual function signatures (abstract contracts)", command: "bash .pipemd/scripts/project/interfaces.sh", category: "cpp", volatile: 1, file: "project/interfaces.sh" },
    { id: "include-graph", label: "Include Graph", description: "External and standard library header dependencies", command: "bash .pipemd/scripts/project/include-graph.sh", category: "cpp", volatile: 1, file: "project/include-graph.sh" },
  ],
  rust: [
    { id: "cargo-deps", label: "Cargo Dependencies", description: "Rust crate dependencies from Cargo.toml", command: "bash .pipemd/scripts/project/cargo-deps.sh", category: "rust", volatile: 1, file: "project/cargo-deps.sh" },
    { id: "cargo-features", label: "Cargo Features", description: "Feature flags and conditional compilation", command: "bash .pipemd/scripts/project/cargo-features.sh", category: "rust", volatile: 1, file: "project/cargo-features.sh" },
  ],
  go: [
    { id: "go-packages", label: "Go Packages", description: "Go module packages and imports", command: "bash .pipemd/scripts/project/go-packages.sh", category: "go", volatile: 1, file: "project/go-packages.sh" },
    { id: "go-interfaces", label: "Go Interfaces", description: "Go interface definitions from source", command: "bash .pipemd/scripts/project/go-interfaces.sh", category: "go", volatile: 1, file: "project/go-interfaces.sh" },
  ],
  devops: [
    { id: "docker-stats", label: "Docker Containers", description: "Running and recently exited container health", command: "bash .pipemd/scripts/devops/docker-stats.sh", category: "devops", volatile: 3, file: "devops/docker-stats.sh" },
    { id: "k8s-unhealthy", label: "K8s Unhealthy Pods", description: "Non-running pods across all namespaces (top 20)", command: "bash .pipemd/scripts/devops/k8s-unhealthy.sh", category: "devops", volatile: 3, file: "devops/k8s-unhealthy.sh" },
    { id: "tf-state", label: "Terraform State", description: "Current workspace and managed resource summary", command: "bash .pipemd/scripts/devops/tf-state.sh", category: "devops", volatile: 2, file: "devops/tf-state.sh" },
    { id: "aws-context", label: "AWS Identity", description: "Current STS caller identity (account, user, ARN)", command: "bash .pipemd/scripts/devops/aws-context.sh", category: "devops", volatile: 2, file: "devops/aws-context.sh" },
  ],
  crew: [
    { id: "crew", label: "Crew Activity", description: "Parallel agents, claimed files, conflict warnings", command: "bash .pipemd/scripts/crew/crew.sh", category: "project", volatile: 2, file: "crew/crew.sh" },
  ],
  context: [
    { id: "now", label: "Current Time", description: "Date and time (rounded to 5 min)", command: "bash .pipemd/scripts/context/now.sh", category: "project", volatile: 5, file: "context/now.sh" },
  ],
};

export const ECOSYSTEM_DIR_MAP: Record<Ecosystem, string> = {
  "Node/TypeScript": "Node-TypeScript",
  Python: "Python",
  "C-CPP": "C-CPP",
  Rust: "Rust",
  Go: "Go",
  DevOps: "DevOps",
  Generic: "Generic",
};

export const VALID_AGENTS: AiAgent[] = ["Claude Code", "Cursor", "Aider", "Gemini", "Generic", "OpenClaw", "Hermes"];
export const VALID_ECOSYSTEMS: Ecosystem[] = ["Node/TypeScript", "Python", "C-CPP", "Rust", "Go", "DevOps", "Generic"];
export const VALID_PROFILES: TokenProfile[] = ["low", "medium", "high", "xhigh", "unlimited"];
export const VALID_HARNESSES: Harness[] = ["OpenCode", "Claude Code", "Cursor", "Gemini", "None", "OpenClaw", "Hermes"];

export const DELIVERY_PROMPTS: Record<string, { title: string; description: string }> = {
  passive: {
    title: "Passive",
    description: "Context rendered to file/pipe. No hooks. Zero agent overhead. Best for Cursor, Aider, CI/CD.",
  },
  active: {
    title: "Active (recommended)",
    description: "Fresh context injected via hooks on every tool call. Agent sees: crew locks, file errors, validation. Best for Claude Code, OpenCode, Gemini.",
  },
  expert: {
    title: "Expert",
    description: "Full control over injection rules. Configure per-hook behavior in injection.yml.",
  },
};

export const HARNESS_DESCRIPTIONS: Record<HarnessName, string> = {
  "OpenCode": "CLI-based AI coding agent",
  "Claude Code": "Anthropic's Claude CLI for coding",
  "Cursor": "AI-powered IDE (needs Legacy mode for .cursorrules)",
  "Aider": "AI pair programming CLI tool",
  "Gemini": "Google's Gemini CLI coding assistant (reads AI_CONTEXT.md)",
  "OpenClaw": "General-purpose OS agent (reads WORKSPACE_CONTEXT.md)",
  "Hermes": "General-purpose OS agent (reads WORKSPACE_CONTEXT.md)",
  "OS Agent": "Fallback: generic OS-level AI agent (reads AGENTS.md)",
};

export const HARNESS_USAGE_TIPS: Record<HarnessName, string> = {
  "OpenCode": "Just type `opencode` and start coding. It natively reads AGENTS.md.",
  "Claude Code": "Just type `claude` and start coding. It natively reads CLAUDE.md.",
  "Cursor": "Press Cmd+L and ask a question. Cursor natively reads .cursorrules.",
  "Aider": "Just type `aider` and start coding. It natively reads CONVENTIONS.md.",
  "Gemini": "Just type `gemini` and start coding. It natively reads AI_CONTEXT.md.",
  "OpenClaw": "Start OpenClaw in this workspace. It reads WORKSPACE_CONTEXT.md as its context.",
  "Hermes": "Start Hermes in this workspace. It reads WORKSPACE_CONTEXT.md as its context.",
  "OS Agent": "Start your agent. It will read AGENTS.md for project context.",
};

export function estimateTokens(lines: number, profile: TokenProfile): number {
  if (profile === "unlimited") return lines * TOKENS_PER_LINE;
  const { num, den } = TOKEN_PROFILES[profile];
  return Math.round((lines * num) / den) * TOKENS_PER_LINE;
}

export function isTrimmed(scriptId: string, actualLines: number, profile: TokenProfile): boolean {
  if (profile === "unlimited") return false;
  const base = SCRIPT_MAX_LINES[scriptId] ?? 50;
  const { num, den } = TOKEN_PROFILES[profile];
  const maxLines = Math.round((base * num) / den) || 1;
  return actualLines >= maxLines;
}

export function contextFileName(agent: AiAgent): string {
  if (agent === "Generic") return "AGENTS.md";
  const mapping: Record<string, string> = {
    "Claude Code": "CLAUDE.md",
    "Cursor": ".cursorrules",
    "Aider": "CONVENTIONS.md",
    "Gemini": "AI_CONTEXT.md",
    "OpenClaw": "WORKSPACE_CONTEXT.md",
    "Hermes": "WORKSPACE_CONTEXT.md",
  };
  return mapping[agent] || "AI_CONTEXT.md";
}
