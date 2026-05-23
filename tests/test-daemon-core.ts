import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
    passed++
  } catch (err: any) {
    console.log(`  \x1b[31m✖\x1b[0m ${name}`)
    console.log(`    ${err.message}`)
    if (err.stack) {
      const lines = err.stack.split("\n").slice(1, 4)
      for (const l of lines) console.log(`    ${l.trim()}`)
    }
    failed++
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-daemon-test-"))

fs.mkdirSync(path.join(tmpDir, ".pipemd"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "crew"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "injected"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "live"), { recursive: true })

const origDir = process.cwd()
process.chdir(tmpDir)

// ─── pipe-manager tests ───

const {
  getCachedRenderedContent,
  setIsRendering,
  getIsRendering,
  isEpipe,
  updateStatus,
  trackedSetTimeout,
  trackedSetInterval,
  activeTimers,
} = await import("../src/core/pipe-manager.js")

test("isEpipe detects EPIPE error code", () => {
  const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
  assert.equal(isEpipe(err), true)
})

test("isEpipe detects EPIPE in message", () => {
  const err = new Error("something EPIPE happened")
  assert.equal(isEpipe(err), true)
})

test("isEpipe returns false for non-EPIPE errors", () => {
  const err = new Error("some other error")
  assert.equal(isEpipe(err), false)
})

test("isEpipe handles string input", () => {
  assert.equal(isEpipe("EPIPE error"), true)
  assert.equal(isEpipe("random string"), false)
})

test("isEpipe handles null/undefined", () => {
  assert.equal(isEpipe(null), false)
  assert.equal(isEpipe(undefined), false)
})

test("getCachedRenderedContent starts empty", () => {
  assert.equal(getCachedRenderedContent(), "")
})

test("setIsRendering / getIsRendering accessor", () => {
  assert.equal(getIsRendering(), false)
  setIsRendering(true)
  assert.equal(getIsRendering(), true)
  setIsRendering(false)
  assert.equal(getIsRendering(), false)
})

test("updateStatus writes status file", () => {
  updateStatus({
    lastRun: "2026-01-01T00:00:00Z",
    durationMs: 42,
    renderedBytes: 100,
  })
  const statusPath = path.join(tmpDir, ".pipemd", ".status.json")
  assert.ok(fs.existsSync(statusPath))
  const data = JSON.parse(fs.readFileSync(statusPath, "utf-8"))
  assert.equal(data.durationMs, 42)
  assert.equal(data.renderedBytes, 100)
})

test("updateStatus handles error field", () => {
  updateStatus({
    lastRun: "2026-01-01T00:00:00Z",
    durationMs: 0,
    error: "test error",
  })
  const statusPath = path.join(tmpDir, ".pipemd", ".status.json")
  const data = JSON.parse(fs.readFileSync(statusPath, "utf-8"))
  assert.equal(data.error, "test error")
})

test("trackedSetTimeout returns a timer ID", () => {
  const id = trackedSetTimeout(() => {}, 10000)
  assert.ok(id)
  clearTimeout(id)
})

test("trackedSetInterval returns a timer ID", () => {
  const id = trackedSetInterval(() => {}, 10000)
  assert.ok(id)
  clearInterval(id)
})

test("activeTimers tracks created timers", () => {
  const before = activeTimers.length
  const id = trackedSetTimeout(() => {}, 10000)
  assert.ok(activeTimers.length > before)
  clearTimeout(id)
})

// ─── daemon-write-back tests ───

const {
  loadBase,
  composeContent,
  splitContextContent,
} = await import("../src/core/daemon-write-back.js")

const testConfig = {
  version: "1.0",
  commands: {} as Record<string, string>,
  injected: [{ file: ".pipemd/template.md", watch: true }],
  pipes: [],
  settings: { debounceMs: 3000, reServeDelayMs: 1000 },
}

test("loadBase returns empty string when no base configured", () => {
  assert.equal(loadBase(testConfig), "")
})

test("loadBase reads base file", () => {
  const baseConfig = {
    ...testConfig,
    base: path.join(tmpDir, ".pipemd", "base.md"),
  }
  fs.writeFileSync(baseConfig.base, "Hello base\n", "utf-8")
  assert.equal(loadBase(baseConfig), "Hello base")
})

test("loadBase returns empty on missing file", () => {
  const baseConfig = {
    ...testConfig,
    base: path.join(tmpDir, ".pipemd", "nonexistent.md"),
  }
  assert.equal(loadBase(baseConfig), "")
})

test("composeContent returns template when no base", () => {
  assert.equal(composeContent("", "template content"), "template content")
})

test("composeContent joins base and template with separator", () => {
  const result = composeContent("base content", "template content")
  assert.ok(result.includes("base content"))
  assert.ok(result.includes("template content"))
  assert.ok(result.includes("<!-- pmd-context -->"))
})

test("splitContextContent splits on separator", () => {
  const content = "base stuff\n\n---\n\n<!-- pmd-context -->\ntemplate stuff"
  const { base, template } = splitContextContent(content)
  assert.equal(base, "base stuff")
  assert.equal(template, "template stuff")
})

test("splitContextContent returns all as template when no separator", () => {
  const content = "just template content"
  const { base, template } = splitContextContent(content)
  assert.equal(base, "")
  assert.equal(template, "just template content")
})

// ─── daemon config / pid tests ───

const { writePidFile, readPidFile } = await import("../src/core/daemon.js")

test("writePidFile / readPidFile roundtrip", () => {
  writePidFile(12345)
  const pid = readPidFile()
  assert.equal(pid, 12345)
})

test("readPidFile returns null when no pid file", () => {
  try { fs.unlinkSync(path.join(tmpDir, ".pipemd", ".daemon.pid")) } catch {}
  assert.equal(readPidFile(), null)
})

test("readPidFile returns null for invalid content", () => {
  fs.writeFileSync(path.join(tmpDir, ".pipemd", ".daemon.pid"), "not-a-number", "utf-8")
  assert.equal(readPidFile(), null)
})

// ─── daemon-config validation tests ───

const { loadConfig, ConfigError } = await import("../src/core/daemon-config.js")

test("loadConfig throws ConfigError for missing config", () => {
  try { fs.unlinkSync(path.join(tmpDir, ".pipemd", "config.yml")) } catch {}
  assert.throws(() => loadConfig(), (err: any) => err instanceof ConfigError)
})

test("loadConfig throws ConfigError for invalid YAML", () => {
  fs.writeFileSync(path.join(tmpDir, ".pipemd", "config.yml"), "{{invalid yaml", "utf-8")
  assert.throws(() => loadConfig(), (err: any) => err instanceof ConfigError)
})

test("loadConfig parses valid config", () => {
  fs.writeFileSync(
    path.join(tmpDir, ".pipemd", "config.yml"),
    `version: "1.0"
commands:
  tree: "echo tree"
injected:
  - file: ".pipemd/template.md"
    watch: true
pipes:
  - file: "AGENTS.md"
    render: ".pipemd/template.md"
settings:
  debounceMs: 3000
  reServeDelayMs: 1000
`,
    "utf-8",
  )
  const config = loadConfig()
  assert.equal(config.version, "1.0")
  assert.ok(config.commands["tree"])
  assert.equal(config.pipes.length, 1)
})

// ─── injector tests ───

const { injectContent, reverseInject } = await import("../src/core/injector.js")

test("injectContent returns null when nothing changes", () => {
  const content = "<!-- pmd: test -->\n```\n\n```\n<!-- /pmd -->"
  const result = injectContent(content, { ...testConfig, commands: {} })
  assert.equal(result, null)
})

test("injectContent replaces blocks with command output", () => {
  const config = { ...testConfig, commands: { echo: "echo hello" } }
  const content = "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->"
  const result = injectContent(content, config)
  assert.ok(result)
  assert.ok(result!.includes("hello"))
})

test("injectContent handles missing command gracefully", () => {
  const config = { ...testConfig, commands: {} }
  const content = "<!-- pmd: nonexistent -->\n```\n\n```\n<!-- /pmd -->"
  const result = injectContent(content, config)
  assert.equal(result, null)
})

test("reverseInject preserves template blocks", () => {
  const template = "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->"
  const rendered = "<!-- pmd: echo -->\n```\nhello world\n```\n<!-- /pmd -->"
  const result = reverseInject(rendered, template)
  assert.equal(result, template)
})

test("reverseInject uses empty block for new tags", () => {
  const template = "<!-- pmd: existing -->\n```\n\n```\n<!-- /pmd -->"
  const rendered = "<!-- pmd: existing -->\n```\nhello\n```\n<!-- /pmd -->\n<!-- pmd: new -->\n```\nstuff\n```\n<!-- /pmd -->"
  const result = reverseInject(rendered, template)
  assert.ok(result.includes("<!-- pmd: new -->"))
  assert.ok(!result.includes("stuff"))
})

// ─── dedup tests ───

const { checkInjectionStatus, recordInjection } = await import("../src/core/dedup.js")

test("checkInjectionStatus returns new for fresh content", () => {
  const status = checkInjectionStatus("test-session", "crew-status", "some content")
  assert.equal(status, "new")
})

test("checkInjectionStatus returns unchanged for repeated content", () => {
  recordInjection("test-session-dup", "crew-status", "unchanged content")
  const status = checkInjectionStatus("test-session-dup", "crew-status", "unchanged content")
  assert.equal(status, "unchanged")
})

test("checkInjectionStatus detects changed content", () => {
  recordInjection("test-session-chg", "crew-status", "original content")
  const status = checkInjectionStatus("test-session-chg", "crew-status", "new content")
  assert.equal(status, "changed")
})

// ─── cleanup ───

process.chdir(origDir)
try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {}

console.log()
console.log(`Daemon core tests: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
