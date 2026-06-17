import { describe, it, after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-resolver-test-"))

fs.mkdirSync(path.join(tmpDir, ".pipemd"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "crew"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "injected"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "sources"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "validation"), { recursive: true })

fs.writeFileSync(
  path.join(tmpDir, ".pipemd", "injection.yml"),
  `delivery: expert
rules:
  after-edit:
    - source: edit-diff
      scope: target-file
      max-lines: 20
    - source: syntax-check
      scope: target-file
      max-lines: 5
    - source: validate-file
      scope: target-file
      max-lines: 15
`,
)

fs.writeFileSync(path.join(tmpDir, "good.js"), "const x = 1;\nconsole.log(x);\n")
fs.writeFileSync(path.join(tmpDir, "bad.js"), "const x = {\n")
fs.writeFileSync(path.join(tmpDir, "good.ts"), "const x: number = 1;\n")
fs.writeFileSync(path.join(tmpDir, "readme.md"), "# Hello\n")

import { execFileSync as setupExec } from "node:child_process"
try {
  setupExec("git", ["init"], { cwd: tmpDir, timeout: 5000 })
  setupExec("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, timeout: 5000 })
  setupExec("git", ["config", "user.name", "Test"], { cwd: tmpDir, timeout: 5000 })
  setupExec("git", ["add", "."], { cwd: tmpDir, timeout: 5000 })
  setupExec("git", ["commit", "-m", "init"], { cwd: tmpDir, timeout: 5000 })
} catch { /* ignore */ }

const origDir = process.cwd()
process.chdir(tmpDir)

const { resolveInjections, triggerAsyncValidation } = await import("../src/core/injection-engine.js")
const { clearMemCache } = await import("../src/core/dedup.js")
const { invalidateCachePattern, writeCache, readCache, DEFAULT_TTLS } = await import("../src/core/cache.js")

function clearDedup() {
  const dir = path.join(tmpDir, ".pipemd", "cache", "injected")
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".json")) fs.unlinkSync(path.join(dir, f))
  }
  clearMemCache()
}

function clearAllCache() {
  for (const sub of ["sources", "validation", "injected"]) {
    const dir = path.join(tmpDir, ".pipemd", "cache", sub)
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".json")) fs.unlinkSync(path.join(dir, f))
    }
  }
  clearMemCache()
}

describe("edit-diff resolver", () => {
  it("returns empty string without target file", async () => {
    clearDedup()
    const payloads = await resolveInjections("after-edit", undefined, "sess-diff-1")
    const editDiff = payloads.find((p) => p.source === "edit-diff")
    assert.ok(!editDiff, "edit-diff should be skipped without target file")
  })

  it("returns nothing for clean file (no diff to report)", async () => {
    clearAllCache()
    const payloads = await resolveInjections("after-edit", "good.js", "sess-diff-2")
    const editDiff = payloads.find((p) => p.source === "edit-diff")
    assert.ok(!editDiff, "edit-diff should be skipped when no unstaged changes")
  })

  it("caches edit-diff results for modified files", async () => {
    clearAllCache()
    fs.appendFileSync(path.join(tmpDir, "good.js"), "// modified\n")
    const first = await resolveInjections("after-edit", "good.js", "sess-diff-3")
    const editDiff1 = first.find((p) => p.source === "edit-diff")
    assert.ok(editDiff1, "edit-diff should be present for modified file")
    const second = await resolveInjections("after-edit", "good.js", "sess-diff-3")
    const editDiff2 = second.find((p) => p.source === "edit-diff")
    assert.ok(!editDiff2, "cached result should be deduped")
  })
})

describe("syntax-check resolver", () => {
  it("returns empty string without target file", async () => {
    clearDedup()
    const payloads = await resolveInjections("after-edit", undefined, "sess-syntax-1")
    const syntax = payloads.find((p) => p.source === "syntax-check")
    assert.ok(!syntax, "syntax-check should be skipped without target file")
  })

  it("detects syntax errors in .js files", async () => {
    clearAllCache()
    const payloads = await resolveInjections("after-edit", "bad.js", "sess-syntax-2")
    const syntax = payloads.find((p) => p.source === "syntax-check")
    assert.ok(syntax, "syntax-check should be present")
    assert.ok(
      syntax.content.toLowerCase().includes("syntax") ||
      syntax.content.includes("Unexpected") ||
      syntax.content.includes("Error"),
      `expected syntax error, got: ${syntax.content}`,
    )
  })

  it("returns no syntax errors for valid .js files", async () => {
    clearAllCache()
    const payloads = await resolveInjections("after-edit", "good.js", "sess-syntax-3")
    const syntax = payloads.find((p) => p.source === "syntax-check")
    assert.ok(syntax, "syntax-check should be present")
    assert.ok(
      syntax.content.includes("No syntax errors"),
      `expected no syntax errors, got: ${syntax.content}`,
    )
  })

  it("returns nothing for unsupported extensions like .md", async () => {
    clearAllCache()
    const payloads = await resolveInjections("after-edit", "readme.md", "sess-syntax-4")
    const syntax = payloads.find((p) => p.source === "syntax-check")
    assert.ok(!syntax, "syntax-check should be skipped for unsupported extensions")
  })

  it("caches syntax check results", async () => {
    clearAllCache()
    const first = await resolveInjections("after-edit", "good.js", "sess-syntax-5")
    const syntax1 = first.find((p) => p.source === "syntax-check")
    assert.ok(syntax1)
    const second = await resolveInjections("after-edit", "good.js", "sess-syntax-5")
    const syntax2 = second.find((p) => p.source === "syntax-check")
    assert.ok(!syntax2, "cached result should be deduped")
  })
})

describe("invalidateCachePattern", () => {
  it("removes cache entries matching pattern", () => {
    const cacheDir = path.join(tmpDir, ".pipemd", "cache", "sources")
    writeCache("edit-diff:src/foo.ts", "some diff", 10000)
    writeCache("syntax-check:src/foo.ts", "no errors", 10000)

    const before = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    assert.ok(before.length >= 2, `expected ≥2 cache files, got ${before.length}`)

    const count = invalidateCachePattern("edit-diff:")
    assert.ok(count >= 1, `expected ≥1 invalidation, got ${count}`)
  })

  it("returns 0 when no entries match", () => {
    clearAllCache()
    const count = invalidateCachePattern("nonexistent%2Fpattern")
    assert.equal(count, 0)
  })
})

describe("updated defaults", () => {
  it("file-errors has max-lines 15 in default rules", async () => {
    process.chdir(origDir)
    const { DEFAULT_ACTIVE_RULES } = await import("../src/core/injection-types.js")
    const beforeEdit = DEFAULT_ACTIVE_RULES.rules["before-edit"]
    assert.ok(beforeEdit, "before-edit rules should exist")
    const fileErrors = beforeEdit.find((r) => r.source === "file-errors")
    assert.ok(fileErrors, "file-errors rule should exist")
    assert.equal(fileErrors["max-lines"], 15)
    const syntaxCheck = beforeEdit.find((r) => r.source === "syntax-check")
    assert.ok(syntaxCheck, "syntax-check rule should exist in before-edit")

    const afterEdit = DEFAULT_ACTIVE_RULES.rules["after-edit"]
    assert.ok(afterEdit, "after-edit rules should exist")
    const editDiff = afterEdit.find((r) => r.source === "edit-diff")
    assert.ok(editDiff, "edit-diff rule should exist in after-edit")

    process.chdir(tmpDir)
  })
})

describe("file-errors dispatch + freshness", () => {
  const injPath = path.join(tmpDir, ".pipemd", "injection.yml")
  let origInj: string | null = null

  before(() => {
    // Force the default active rules so before-edit `file-errors` is active.
    origInj = fs.existsSync(injPath) ? fs.readFileSync(injPath, "utf8") : null
    if (fs.existsSync(injPath)) fs.unlinkSync(injPath)
  })
  after(() => {
    if (origInj !== null) fs.writeFileSync(injPath, origInj)
    else if (fs.existsSync(injPath)) fs.unlinkSync(injPath)
  })

  it("suppresses validation for a file type with no validator (no eslint-on-non-JS leak)", async () => {
    clearAllCache()
    const f = path.join(tmpDir, "unknown.xyz")
    fs.writeFileSync(f, "data\n")
    await triggerAsyncValidation(f)
    const entry = readCache(`validation:${f}`)
    assert.equal(entry, null, "no validation entry should exist for an unsupported file type")
  })

  it("suppresses a stale entry when the file changed after validation", async () => {
    clearDedup()
    const f = path.join(tmpDir, "stale.ts")
    fs.writeFileSync(f, "export const x = 1;\n")
    const mtimeAtValidation = fs.statSync(f).mtimeMs
    writeCache(`validation:${f}`, "STALE: a since-fixed lint issue", DEFAULT_TTLS.validation, { mtime: String(mtimeAtValidation) })
    // Bump the file's mtime into the future so current mtime > snapshotted mtime → stale.
    const future = Math.floor(Date.now() / 1000) + 60
    fs.utimesSync(f, future, future)
    const payloads = await resolveInjections("before-edit", f, "sess-stale")
    const fe = payloads.find((p) => p.source === "file-errors")
    assert.equal(fe, undefined, "stale entry (file mtime > snapshotted mtime) should be suppressed")
  })

  it("serves a fresh entry when the file is unchanged since validation", async () => {
    clearDedup()
    const f = path.join(tmpDir, "fresh.ts")
    fs.writeFileSync(f, "export const y = 2;\n")
    // Snapshot the file's mtime at validation time (same as triggerAsyncValidation does).
    const mtimeAtValidation = fs.statSync(f).mtimeMs
    writeCache(`validation:${f}`, "FRESH: a real lint issue", DEFAULT_TTLS.validation, { mtime: String(mtimeAtValidation) })
    const payloads = await resolveInjections("before-edit", f, "sess-fresh")
    const fe = payloads.find((p) => p.source === "file-errors")
    assert.ok(fe, "fresh entry should be served")
    assert.ok(fe!.content.includes("FRESH"), `expected FRESH marker in: ${fe?.content}`)
  })
})

after(() => {
  process.chdir(origDir)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
