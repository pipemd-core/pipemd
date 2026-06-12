import { describe, it, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { detectProject } from "../src/core/detect.js"

const fixturesDir = path.join(import.meta.dirname, "fixtures")

let tmpDir: string
let origCwd: string

function copyFixture(name: string): string {
  const src = path.join(fixturesDir, name)
  const dest = path.join(tmpDir, name)
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (f) => !f.includes("/.git/") && !f.includes("/.git"),
  })
  return dest
}

before(() => {
  origCwd = process.cwd()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-detect-test-"))
})

after(() => {
  process.chdir(origCwd)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("detectProject — ecosystem identification", () => {
  it("detects Node/TypeScript from express-project fixture", () => {
    const dir = copyFixture("express-project")
    const result = detectProject(dir)
    assert.equal(result.ecosystem, "Node/TypeScript")
    assert.ok(result.signals.some((s) => s.includes("package.json")))
    assert.ok(result.recommendedScripts.includes("deps"))
  })

  it("detects Rust from rust-project fixture", () => {
    const dir = copyFixture("rust-project")
    const result = detectProject(dir)
    assert.equal(result.ecosystem, "Rust")
    assert.ok(result.signals.some((s) => s.includes("Cargo.toml")))
    assert.ok(result.recommendedScripts.includes("cargo-deps"))
  })

  it("detects Go from go-project fixture", () => {
    const dir = copyFixture("go-project")
    const result = detectProject(dir)
    assert.equal(result.ecosystem, "Go")
    assert.ok(result.signals.some((s) => s.includes("go.mod")))
    assert.ok(result.recommendedScripts.includes("go-packages"))
  })

  it("detects DevOps from devops-project fixture", () => {
    const dir = copyFixture("devops-project")
    const result = detectProject(dir)
    assert.equal(result.ecosystem, "DevOps")
    assert.ok(result.signals.some((s) => s.includes("Dockerfile")))
  })

  it("detects C/C++ from cpp-project fixture", () => {
    const dir = copyFixture("cpp-project")
    const result = detectProject(dir)
    assert.equal(result.ecosystem, "C-CPP")
    assert.ok(result.signals.some((s) => s.includes("CMakeLists.txt")))
  })

  it("detects Python from fastapi-project fixture", () => {
    const dir = copyFixture("fastapi-project")
    const result = detectProject(dir)
    assert.equal(result.ecosystem, "Python")
    assert.ok(result.signals.some((s) => s.includes("pyproject.toml")))
  })

  it("detects Python from sqlalchemy-project fixture", () => {
    const dir = copyFixture("sqlalchemy-project")
    const result = detectProject(dir)
    assert.equal(result.ecosystem, "Python")
  })

  it("detects Python from django-project fixture", () => {
    const dir = copyFixture("django-project")
    const result = detectProject(dir)
    assert.equal(result.ecosystem, "Python")
  })

  it("returns Generic for empty directory", () => {
    const emptyDir = path.join(tmpDir, "empty-project")
    fs.mkdirSync(emptyDir)
    const result = detectProject(emptyDir)
    assert.equal(result.ecosystem, "Generic")
    assert.equal(result.signals.length, 0)
  })
})

describe("detectProject — signal detection", () => {
  it("detects git in express-project fixture", () => {
    const dir = copyFixture("express-project")
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes(".git → git-context")))
    assert.ok(result.recommendedScripts.includes("git-context"))
  })

  it("Express routes not auto-detected (opt-in via --blocks)", () => {
    const dir = copyFixture("express-project")
    const result = detectProject(dir)
    assert.ok(!result.recommendedScripts.includes("express-routes"),
      "express-routes should not be auto-detected (removed from defaults)")
  })

  it("detects FastAPI in fastapi-project fixture", () => {
    const dir = copyFixture("fastapi-project")
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes("FastAPI detected")))
    assert.ok(result.recommendedScripts.includes("fastapi-routes"))
  })

  it("detects Rust features in rust-project fixture", () => {
    const dir = copyFixture("rust-project")
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes("Cargo features detected")))
  })

  it("detects Go source files in go-project fixture", () => {
    const dir = copyFixture("go-project")
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes("Go source files detected")))
  })

  it("detects C++ inheritance in cpp-project fixture", () => {
    const dir = copyFixture("cpp-project")
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes("class inheritance")))
    assert.ok(result.signals.some((s) => s.includes("Pure virtual methods")))
    assert.ok(result.signals.some((s) => s.includes("C++ headers detected")))
  })

  it("monorepo signals are not added to defaults (opt-in only)", () => {
    const dir = copyFixture("monorepo-project")
    const result = detectProject(dir)
    assert.ok(!result.recommendedScripts.includes("compose"))
    assert.ok(!result.recommendedScripts.includes("workspace-map"))
  })

  it("detects Next.js App Router from nextjs-project fixture", () => {
    const dir = copyFixture("nextjs-project")
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes("Next.js App Router")))
  })

  it("NestJS controllers not auto-detected (opt-in via --blocks)", () => {
    const dir = copyFixture("nestjs-project")
    const result = detectProject(dir)
    assert.ok(!result.recommendedScripts.includes("nest-controllers"),
      "nest-controllers should not be auto-detected (removed from defaults)")
  })

  it("detects Angular routing from angular-project fixture", () => {
    const dir = copyFixture("angular-project")
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes("Angular detected")))
    assert.ok(result.recommendedScripts.includes("angular-structure"))
  })

  it("detects Angular standalone routes from angular-standalone-project fixture", () => {
    const dir = copyFixture("angular-standalone-project")
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes("Angular detected")))
    assert.ok(result.recommendedScripts.includes("angular-structure"))
  })

  it("React components not auto-detected (opt-in via --blocks)", () => {
    const dir = copyFixture("react-project")
    const result = detectProject(dir)
    assert.ok(!result.recommendedScripts.includes("react-components"),
      "react-components should not be auto-detected (removed from defaults)")
  })

  it("detects Prisma from prisma-project fixture", () => {
    const dir = copyFixture("prisma-project")
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes("schema.prisma")))
    assert.ok(result.recommendedScripts.includes("prisma"))
  })

  it("detects Terraform in devops-project fixture", () => {
    const dir = copyFixture("devops-project")
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes("Terraform")))
  })

  it("does not add test-summary to defaults (opt-in only)", () => {
    const dir = copyFixture("go-project")
    const result = detectProject(dir)
    assert.ok(!result.recommendedScripts.includes("test-summary"))
  })

  it("does not add test-summary to Rust defaults (opt-in only)", () => {
    const dir = copyFixture("rust-project")
    const result = detectProject(dir)
    assert.ok(!result.recommendedScripts.includes("test-summary"))
  })

  it("detects Django models from django-project fixture", () => {
    const dir = copyFixture("django-project")
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes("models.py")))
  })

  it("detects sqlalchemy dependency from sqlalchemy-project fixture", () => {
    const dir = copyFixture("sqlalchemy-project")
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes("sqlalchemy")))
  })

  it("includes tree, deps, exports in all recommendations", () => {
    const emptyDir = path.join(tmpDir, "bare-project")
    fs.mkdirSync(emptyDir, { recursive: true })
    const result = detectProject(emptyDir)
    assert.ok(result.recommendedScripts.includes("tree"))
    assert.ok(result.recommendedScripts.includes("deps"))
    assert.ok(result.recommendedScripts.includes("exports"))
    assert.ok(!result.recommendedScripts.includes("arch"))
    assert.ok(!result.recommendedScripts.includes("todos"))
  })
})

describe("detectProject — deduplication of recommended scripts", () => {
  it("does not duplicate recommended scripts", () => {
    const dir = copyFixture("express-project")
    const result = detectProject(dir)
    const counts = new Map<string, number>()
    for (const s of result.recommendedScripts) {
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    for (const [script, count] of counts) {
      assert.equal(count, 1, `Script "${script}" appears ${count} times`)
    }
  })

  it("does not duplicate recommended scripts for monorepo", () => {
    const dir = copyFixture("monorepo-project")
    const result = detectProject(dir)
    const counts = new Map<string, number>()
    for (const s of result.recommendedScripts) {
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    for (const [script, count] of counts) {
      assert.equal(count, 1, `Script "${script}" appears ${count} times`)
    }
  })
})

describe("detectProject — DevOps scripts only for DevOps-primary ecosystem", () => {
  it("does not add DevOps scripts to Node/TypeScript project with Dockerfile", () => {
    const dir = path.join(tmpDir, "node-with-docker")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"test"}')
    fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM node:20\n")
    const result = detectProject(dir)
    assert.equal(result.ecosystem, "Node/TypeScript")
    assert.ok(!result.recommendedScripts.includes("docker-stats"))
    assert.ok(!result.recommendedScripts.includes("tf-state"))
  })
})

describe("detectProject — lint detection", () => {
  it("detects eslint config", () => {
    const dir = path.join(tmpDir, "linted-project")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"test"}')
    fs.writeFileSync(path.join(dir, ".eslintrc.json"), '{}')
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes(".eslintrc.json")))
    assert.ok(result.recommendedScripts.includes("lint"))
  })

  it("detects ruff config in Python project", () => {
    const dir = path.join(tmpDir, "ruff-project")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "pyproject.toml"), '[tool.ruff]\n')
    fs.writeFileSync(path.join(dir, "ruff.toml"), 'line-length = 88\n')
    const result = detectProject(dir)
    assert.ok(result.signals.some((s) => s.includes("ruff.toml")))
    assert.ok(result.recommendedScripts.includes("lint"))
  })
})
