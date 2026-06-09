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
  const recommended: string[] = ["arch", "tree", "todos"];
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
    signals.push(".git → git scripts");
    recommended.push("git-log", "git-branch", "git-status", "diff-stat");
  }

  // ── DevOps Detection (supplementary — adds scripts to any ecosystem) ──

  const devopsSignals: string[] = [];
  if (has("Dockerfile")) { devopsSignals.push("Dockerfile → docker-stats"); recommended.push("docker-stats"); }
  if (has("docker-compose.yml") || has("docker-compose.yaml")) { devopsSignals.push("docker-compose → docker-stats"); recommended.push("docker-stats"); }
  if (hasIn(".", /\.tf$/) || has(".terraform")) { devopsSignals.push("Terraform → tf-state"); recommended.push("tf-state"); }
  if (hasIn(".", /chart\.yaml$/i)) { devopsSignals.push("Helm chart → k8s-unhealthy"); recommended.push("k8s-unhealthy"); }
  if (has("kustomization.yaml")) { devopsSignals.push("Kustomize → k8s-unhealthy"); recommended.push("k8s-unhealthy"); }
  if (has("skaffold.yaml")) { devopsSignals.push("Skaffold → k8s-unhealthy"); recommended.push("k8s-unhealthy"); }
  if (hasIn(".", /Dockerfile/i) && !has("Dockerfile")) { devopsSignals.push("Dockerfile (subdir) → docker-stats"); recommended.push("docker-stats"); }
  // Only push DevOps supplementary signals if ecosystem is NOT already DevOps
  if (ecosystem !== "DevOps" && devopsSignals.length > 0) {
    signals.push(...devopsSignals);
  }

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

  // ── Test Detection ──

  const testConfigs = [
    "jest.config.js", "jest.config.ts", "jest.config.mjs",
    "vitest.config.ts", "vitest.config.js",
    "pytest.ini", "conftest.py",
    "Cargo.toml",
    "go.mod",
  ];
  const foundTest = testConfigs.find(has);
  if (foundTest) {
    signals.push(`${foundTest} → test-summary`);
    recommended.push("test-summary");
  }

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

  // ── API Framework Detection ──

  if (ecosystem === "Node/TypeScript") {
    const srcDirs = ["src", "routes", "app", "lib", "server", "api", "v1"];
    for (const d of srcDirs) {
      if (fs.existsSync(path.join(cwd, d))) {
        try {
          const allFiles = fs.readdirSync(path.join(cwd, d), { recursive: true }).map(String);
          const jsFiles = allFiles.filter(f => !f.includes("node_modules") && /\.(ts|js|mjs)$/.test(f));
          const content = jsFiles.slice(0, 40).map((f) => {
            try { return fs.readFileSync(path.join(cwd, d, f), "utf-8"); } catch (err: unknown) { log.debug(`readFile failed for ${f}: ${errMsg(err)}`); return ""; }
          }).join("\n");
          if (content.includes("app.get") || content.includes("router.get") || content.includes("router.post")) {
            signals.push("Express routes detected → express-routes");
            recommended.push("express-routes");
            break;
          }
        } catch (err: unknown) { log.debug(`Express route detection readdir failed for ${d}: ${errMsg(err)}`); }
      }
    }
    if (hasIn("src", /controller.*\.ts/) || hasIn("src", /\.controller\.ts/)) {
      signals.push("NestJS controllers detected → nest-controllers");
      recommended.push("nest-controllers");
    }
  }

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
    if (hasIn("src", /\.tsx$/) || hasIn("src", /\.jsx$/)) {
      signals.push("React components detected → react-components");
      recommended.push("react-components");
    }
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

  // ── Monorepo / Multi-package Detection ──

  const monorepoSignals: string[] = [];
  if (has("turbo.json")) { monorepoSignals.push("turbo.json → monorepo"); }
  if (has("nx.json")) { monorepoSignals.push("nx.json → monorepo"); }
  if (has("lerna.json")) { monorepoSignals.push("lerna.json → monorepo"); }
  if (has("pnpm-workspace.yaml") || has("pnpm-workspace.yml")) { monorepoSignals.push("pnpm workspace → monorepo"); }

  const monorepoDirPatterns = ["apps", "packages", "services", "libs", "modules", "workspaces"];
  let hasMonorepoDirs = false;
  for (const dir of monorepoDirPatterns) {
    if (fs.existsSync(path.join(cwd, dir)) && fs.statSync(path.join(cwd, dir)).isDirectory()) {
      hasMonorepoDirs = true;
      break;
    }
  }

  let subReadmeCount = 0;
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        const subReadme = path.join(cwd, entry.name, "README.md");
        if (fs.existsSync(subReadme)) {
          subReadmeCount++;
        }
        try {
          const subEntries = fs.readdirSync(path.join(cwd, entry.name), { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isDirectory() && !sub.name.startsWith(".")) {
              const deepReadme = path.join(cwd, entry.name, sub.name, "README.md");
              if (fs.existsSync(deepReadme)) {
                subReadmeCount++;
              }
            }
          }
        } catch (err: unknown) { log.debug(`monorepo subdirectory readdir failed: ${errMsg(err)}`); }
      }
    }
  } catch (err: unknown) { log.debug(`monorepo detection readdir failed: ${errMsg(err)}`); }

  if (monorepoSignals.length > 0 || hasMonorepoDirs || subReadmeCount >= 2) {
    if (monorepoSignals.length > 0) {
      signals.push(...monorepoSignals);
    }
    if (hasMonorepoDirs) {
      signals.push("monorepo directory structure detected → compose");
    }
    if (subReadmeCount >= 2) {
      signals.push(`${subReadmeCount} sub-directory READMEs → compose`);
    }
    recommended.push("compose");
    recommended.push("workspace-map");
  }

  if (ecosystem === "Rust" && has("Cargo.toml")) {
    try {
      const cargoContent = fs.readFileSync(path.join(cwd, "Cargo.toml"), "utf-8");
      if (cargoContent.includes("[workspace]")) {
        signals.push("Cargo workspace → workspace-map");
        recommended.push("workspace-map");
      }
    } catch (err: unknown) { log.debug(`Cargo.toml workspace check failed: ${errMsg(err)}`); }
  }

  if (ecosystem === "Go" && has("go.work")) {
    signals.push("go.work → workspace-map");
    recommended.push("workspace-map");
  }

  return {
    ecosystem,
    recommendedScripts: [...new Set(recommended)],
    signals,
  };
}