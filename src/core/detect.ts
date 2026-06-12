import fs from "node:fs";
import path from "node:path";
import { log, errMsg } from "./logger.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "__pycache__", "vendor", "target", ".terraform", "cmake-build-", "_deps"]);

export type Ecosystem = "Node/TypeScript" | "Python" | "C-CPP" | "Rust" | "Go" | "DevOps" | "Generic";

export interface DetectionResult {
  ecosystem: Ecosystem;
  recommendedScripts: string[];
  signals: string[];
}

export function detectProject(cwd: string = process.cwd()): DetectionResult {
  const recommended: string[] = ["tree", "deps", "exports"];
  const signals: string[] = [];
  let ecosystem: Ecosystem = "Generic";

  const has = (file: string) => fs.existsSync(path.join(cwd, file));
  const hasIn = (dir: string, pattern: RegExp): boolean => {
    const dirPath = path.join(cwd, dir);
    if (!fs.existsSync(dirPath)) return false;
    try {
      const stack: string[] = [dirPath];
      while (stack.length > 0) {
        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (err: unknown) { log.debug(`readdirSync failed for ${current}: ${errMsg(err)}`); continue; }
        for (const entry of entries) {
          const name = entry.name;
          if (SKIP_DIRS.has(name)) continue;
          if (entry.isDirectory()) {
            stack.push(path.join(current, name));
          } else if (pattern.test(name)) {
            return true;
          }
        }
      }
      return false;
    } catch (err: unknown) { log.debug(`hasIn failed for ${dir}: ${errMsg(err)}`); return false; }
  };

  // ── Ecosystem Detection ──

  if (has("package.json")) {
    ecosystem = "Node/TypeScript";
    signals.push("package.json → Node/TypeScript");
    recommended.push("deps");
    if (has("tsconfig.json")) {
      signals.push("tsconfig.json → type-check");
      recommended.push("type-check");
    }
  } else if (has("Cargo.toml")) {
    ecosystem = "Rust";
    signals.push("Cargo.toml → Rust");
    recommended.push("cargo-deps", "cargo-features");
  } else if (has("go.mod")) {
    ecosystem = "Go";
    signals.push("go.mod → Go");
    recommended.push("go-packages", "go-interfaces");
  } else if (has("pyproject.toml") || has("requirements.txt") || has("setup.py") || has("Pipfile") || has("poetry.lock") || has("manage.py")) {
    ecosystem = "Python";
    const found = has("pyproject.toml") ? "pyproject.toml"
      : has("poetry.lock") ? "poetry.lock"
      : has("Pipfile") ? "Pipfile"
      : has("requirements.txt") ? "requirements.txt"
      : has("manage.py") ? "manage.py"
      : "setup.py";
    signals.push(`${found} → Python`);
    recommended.push("deps");
  } else if (
    has("Dockerfile") || has("docker-compose.yml") || has("docker-compose.yaml") ||
    hasIn(".", /\.tf$/) || has(".terraform") ||
    hasIn(".", /helm/i) || hasIn(".", /chart\.yaml$/i) ||
    has("kustomization.yaml") || has("skaffold.yaml")
  ) {
    ecosystem = "DevOps";
    const devopsSignals: string[] = [];
    if (has("Dockerfile")) devopsSignals.push("Dockerfile → DevOps");
    if (has("docker-compose.yml") || has("docker-compose.yaml")) devopsSignals.push("docker-compose → DevOps");
    if (hasIn(".", /\.tf$/) || has(".terraform")) devopsSignals.push("Terraform → DevOps");
    if (hasIn(".", /chart\.yaml$/i)) devopsSignals.push("Helm chart → DevOps");
    if (has("kustomization.yaml")) devopsSignals.push("Kustomize → DevOps");
    if (has("skaffold.yaml")) devopsSignals.push("Skaffold → DevOps");
    signals.push(...devopsSignals);
    recommended.push("docker-stats", "k8s-unhealthy", "tf-state", "aws-context");
  } else if (has("CMakeLists.txt") || hasIn(".", /\.(cpp|cc|cxx|h|hpp|hxx)$/) || has("Makefile") || has("meson.build") || has("WORKSPACE") || has("BUILD.bazel")) {
    ecosystem = "C-CPP";
    if (has("CMakeLists.txt")) {
      signals.push("CMakeLists.txt → C/C++");
    } else if (has("WORKSPACE") || has("BUILD.bazel")) {
      signals.push("Bazel → C/C++");
    } else if (has("meson.build")) {
      signals.push("meson.build → C/C++");
    } else if (has("Makefile")) {
      signals.push("Makefile → C/C++");
    } else {
      signals.push("C/C++ source files detected");
    }
    recommended.push("deps");
  }

  // ── Git Detection ──

  if (has(".git")) {
    signals.push(".git → git-context");
    recommended.push("git-context");
  }

  // ── DevOps Detection (supplementary — only for DevOps-primary ecosystem) ──
  // Note: DevOps blocks (docker-stats, tf-state, k8s-unhealthy, aws-context)
  // are only added when the primary ecosystem is DevOps. Non-DevOps projects
  // must opt in via --blocks flag or manual config.yml editing.

  // ── Lint Detection ──

  const lintConfigs = [
    ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs",
    "eslint.config.js", "eslint.config.mjs", "eslint.config.ts",
    "ruff.toml", ".flake8",
    "clippy.toml", ".clippy.toml",
  ];
  const foundLint = lintConfigs.find(has);
  if (foundLint) {
    signals.push(`${foundLint} → lint`);
    recommended.push("lint");
  }

  // ── Test Detection (opt-in only — often exceeds daemon timeout) ──

  // ── Dead-Code Detection (opt-in only — requires knip and first-render delay) ──

  // ── Database / ORM Detection ──

  if (has("prisma/schema.prisma") || has("src/prisma/schema.prisma")) {
    signals.push("schema.prisma → prisma");
    recommended.push("prisma");
  }
  if (ecosystem === "Python" && hasIn(".", /models\.py/)) {
    signals.push("models.py → django-models");
    recommended.push("django-models");
  }
  if (ecosystem === "Python" && hasIn(".", /urls\.py/) && hasIn(".", /models\.py/)) {
    signals.push("urls.py → django-urls");
    recommended.push("django-urls");
  }
  if (ecosystem === "Python" && has("pyproject.toml")) {
    try {
      const pyprojectContent = fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf-8");
      if (pyprojectContent.includes("sqlalchemy")) {
        signals.push("sqlalchemy dependency → sqlalchemy models");
        recommended.push("sqlalchemy");
      }
    } catch (err: unknown) { log.debug(`pyproject.toml read failed: ${errMsg(err)}`); }
  }

  // ── API Framework Detection (opt-in only via --blocks) ──
  // Express/NestJS detection removed from auto-detect: 15/15 agent retrospectives
  // flagged express-routes as useless. Available via --blocks or config.yml.

  if (ecosystem === "Python") {
    try {
      const pythonFiles: string[] = [];
      const walkDir = (dir: string, rel: string) => {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "venv" && entry.name !== ".venv" && entry.name !== "__pycache__") {
              walkDir(full, relPath);
            } else if (entry.isFile() && /^(main|app)\.py$/.test(entry.name)) {
              pythonFiles.push(full);
            }
          }
        } catch (err: unknown) { log.debug(`walkDir readdir failed for ${dir}: ${errMsg(err)}`); }
      };
      walkDir(cwd, "");
      for (const f of pythonFiles.slice(0, 5)) {
        const content = fs.readFileSync(f, "utf-8");
        if (content.includes("FastAPI") || content.includes("@app.get") || content.includes("@router.get")) {
          signals.push("FastAPI detected → fastapi-routes");
          recommended.push("fastapi-routes");
          break;
        }
      }
    } catch (err: unknown) { log.debug(`FastAPI detection failed: ${errMsg(err)}`); }
  }

  // ── C/C++ Script Detection ──

  if (ecosystem === "C-CPP") {
    if (has("CMakeLists.txt")) {
      signals.push("CMakeLists.txt → cmake-targets");
      recommended.push("cmake-targets");
    }
    if (hasIn(".", /\.(h|hpp|hxx)$/)) {
      try {
        const headerFiles = fs.readdirSync(cwd, { recursive: true })
          .map(String)
          .filter((f) => /\.(h|hpp|hxx)$/.test(f))
          .filter((f) => !f.includes("build/") && !f.includes("cmake-build-") && !f.includes("_deps/") && !f.includes(".git/"));
        if (headerFiles.length > 0) {
          let hasVirtual = false;
          let hasInheritance = false;
          for (const f of headerFiles.slice(0, 30)) {
            try {
              const content = fs.readFileSync(path.join(cwd, f), "utf-8");
              if (content.includes("= 0") && content.includes("virtual")) hasVirtual = true;
              if (content.includes(": public") || content.includes(": private") || content.includes(": protected")) hasInheritance = true;
            } catch (err: unknown) { log.debug(`C++ header read failed for ${f}: ${errMsg(err)}`); }
          }
          if (hasInheritance) {
            signals.push("C++ class inheritance detected → class-diagram");
            recommended.push("class-diagram");
          }
          if (hasVirtual) {
            signals.push("Pure virtual methods detected → interfaces");
            recommended.push("interfaces");
          }
          signals.push("C++ headers detected → include-graph");
          recommended.push("include-graph");
        }
      } catch (err: unknown) { log.debug(`C++ header scan failed: ${errMsg(err)}`); }
    }
  }

  // ── Frontend Framework Detection ──

  if (ecosystem === "Node/TypeScript" || ecosystem === "Python") {
    if (has("app") && hasIn("app", /page\.(tsx|ts|jsx|js)$/)) {
      signals.push("Next.js App Router detected → nextjs-app-router");
      recommended.push("nextjs-app-router");
    }
    // React detection (opt-in only via --blocks)
    // Removed from auto-detect: 10/15 agent retrospectives flagged react-components
    // as useless. Available via --blocks or config.yml.
    if (hasIn("src", /-routing\.module\.ts$/) || hasIn("src", /app-routing/) || hasIn("src", /\.routes\.ts$/) || has("angular.json")) {
      signals.push("Angular detected → angular-structure");
      recommended.push("angular-structure");
    }
  }

  // ── Rust Detection ──

  if (ecosystem === "Rust") {
    if (has("Cargo.toml")) {
      try {
        const cargoContent = fs.readFileSync(path.join(cwd, "Cargo.toml"), "utf-8");
        if (cargoContent.includes("[features]")) {
          signals.push("Cargo features detected → cargo-features");
          recommended.push("cargo-features");
        }
      } catch (err: unknown) { log.debug(`Cargo.toml read failed: ${errMsg(err)}`); }
    }
  }

  // ── Go Detection ──

  if (ecosystem === "Go") {
    if (hasIn(".", /\.go$/)) {
      signals.push("Go source files detected → go-interfaces");
    }
  }

  // ── Monorepo / Multi-package Detection (opt-in only — low signal-to-noise) ──

  return {
    ecosystem,
    recommendedScripts: [...new Set(recommended)],
    signals,
  };
}