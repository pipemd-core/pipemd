import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmd-daemon-test-"))

fs.mkdirSync(path.join(tmpDir, ".pipemd"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "crew"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "cache", "injected"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".pipemd", "live"), { recursive: true })

const origDir = process.cwd()
process.chdir(tmpDir)

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

describe("isEpipe", () => {
  it("detects EPIPE error code", () => {
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
    assert.equal(isEpipe(err), true)
  })

  it("detects EPIPE in message", () => {
    const err = new Error("something EPIPE happened")
    assert.equal(isEpipe(err), true)
  })

  it("returns false for non-EPIPE errors", () => {
    const err = new Error("some other error")
    assert.equal(isEpipe(err), false)
  })

  it("handles string input", () => {
    assert.equal(isEpipe("EPIPE error"), true)
    assert.equal(isEpipe("random string"), false)
  })

  it("handles null/undefined", () => {
    assert.equal(isEpipe(null), false)
    assert.equal(isEpipe(undefined), false)
  })
})

describe("pipe-manager state", () => {
  it("getCachedRenderedContent starts empty", () => {
    assert.equal(getCachedRenderedContent(), "")
  })

  it("setIsRendering / getIsRendering accessor", () => {
    assert.equal(getIsRendering(), false)
    setIsRendering(true)
    assert.equal(getIsRendering(), true)
    setIsRendering(false)
    assert.equal(getIsRendering(), false)
  })
})

describe("updateStatus", () => {
  it("writes status file", () => {
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

  it("handles error field", () => {
    updateStatus({
      lastRun: "2026-01-01T00:00:00Z",
      durationMs: 0,
      error: "test error",
    })
    const statusPath = path.join(tmpDir, ".pipemd", ".status.json")
    const data = JSON.parse(fs.readFileSync(statusPath, "utf-8"))
    assert.equal(data.error, "test error")
  })
})

describe("tracked timers", () => {
  it("trackedSetTimeout returns a timer ID", () => {
    const id = trackedSetTimeout(() => {}, 10000)
    assert.ok(id)
    clearTimeout(id)
  })

  it("trackedSetInterval returns a timer ID", () => {
    const id = trackedSetInterval(() => {}, 10000)
    assert.ok(id)
    clearInterval(id)
  })

  it("activeTimers tracks created timers", () => {
    const before = activeTimers.length
    const id = trackedSetTimeout(() => {}, 10000)
    assert.ok(activeTimers.length > before)
    clearTimeout(id)
  })
})

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

describe("loadBase", () => {
  it("returns empty string when no base configured", () => {
    assert.equal(loadBase(testConfig), "")
  })

  it("reads base file", () => {
    const baseConfig = {
      ...testConfig,
      base: path.join(tmpDir, ".pipemd", "base.md"),
    }
    fs.writeFileSync(baseConfig.base, "Hello base\n", "utf-8")
    assert.equal(loadBase(baseConfig), "Hello base")
  })

  it("returns empty on missing file", () => {
    const baseConfig = {
      ...testConfig,
      base: path.join(tmpDir, ".pipemd", "nonexistent.md"),
    }
    assert.equal(loadBase(baseConfig), "")
  })
})

describe("composeContent", () => {
  it("returns template when no base", () => {
    assert.equal(composeContent("", "template content"), "template content")
  })

  it("joins base and template with separator", () => {
    const result = composeContent("base content", "template content")
    assert.ok(result.includes("base content"))
    assert.ok(result.includes("template content"))
    assert.ok(result.includes("<!-- pmd-context -->"))
  })
})

describe("splitContextContent", () => {
  it("splits on separator", () => {
    const content = "base stuff\n\n---\n\n<!-- pmd-context -->\ntemplate stuff"
    const { base, template } = splitContextContent(content)
    assert.equal(base, "base stuff")
    assert.equal(template, "template stuff")
  })

  it("returns all as template when no separator", () => {
    const content = "just template content"
    const { base, template } = splitContextContent(content)
    assert.equal(base, "")
    assert.equal(template, "just template content")
  })
})

const { writePidFile, readPidFile } = await import("../src/core/daemon.js")

describe("PID file", () => {
  it("writePidFile / readPidFile roundtrip", () => {
    writePidFile(12345)
    const pid = readPidFile()
    assert.equal(pid, 12345)
  })

  it("readPidFile returns null when no pid file", () => {
    try { fs.unlinkSync(path.join(tmpDir, ".pipemd", ".daemon.pid")) } catch {}
    assert.equal(readPidFile(), null)
  })

  it("readPidFile returns null for invalid content", () => {
    fs.writeFileSync(path.join(tmpDir, ".pipemd", ".daemon.pid"), "not-a-number", "utf-8")
    assert.equal(readPidFile(), null)
  })
})

const { loadConfig, ConfigError } = await import("../src/core/daemon-config.js")

describe("loadConfig", () => {
  it("throws ConfigError for missing config", () => {
    try { fs.unlinkSync(path.join(tmpDir, ".pipemd", "config.yml")) } catch {}
    assert.throws(() => loadConfig(), (err: any) => err instanceof ConfigError)
  })

  it("throws ConfigError for invalid YAML", () => {
    fs.writeFileSync(path.join(tmpDir, ".pipemd", "config.yml"), "{{invalid yaml", "utf-8")
    assert.throws(() => loadConfig(), (err: any) => err instanceof ConfigError)
  })

  it("parses valid config", () => {
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
})

const { injectContent, reverseInject } = await import("../src/core/injector.js")

describe("injectContent", () => {
  it("returns null when nothing changes", () => {
    const content = "<!-- pmd: test -->\n```\n\n```\n<!-- /pmd -->"
    const result = injectContent(content, { ...testConfig, commands: {} })
    assert.equal(result, null)
  })

  it("replaces blocks with command output", () => {
    const config = { ...testConfig, commands: { echo: "echo hello" } }
    const content = "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->"
    const result = injectContent(content, config)
    assert.ok(result)
    assert.ok(result!.includes("hello"))
  })

  it("handles missing command gracefully", () => {
    const config = { ...testConfig, commands: {} }
    const content = "<!-- pmd: nonexistent -->\n```\n\n```\n<!-- /pmd -->"
    const result = injectContent(content, config)
    assert.equal(result, null)
  })
})

describe("reverseInject", () => {
  it("preserves template blocks", () => {
    const template = "<!-- pmd: echo -->\n```\n\n```\n<!-- /pmd -->"
    const rendered = "<!-- pmd: echo -->\n```\nhello world\n```\n<!-- /pmd -->"
    const result = reverseInject(rendered, template)
    assert.equal(result, template)
  })

  it("uses empty block for new tags", () => {
    const template = "<!-- pmd: existing -->\n```\n\n```\n<!-- /pmd -->"
    const rendered = "<!-- pmd: existing -->\n```\nhello\n```\n<!-- /pmd -->\n<!-- pmd: new -->\n```\nstuff\n```\n<!-- /pmd -->"
    const result = reverseInject(rendered, template)
    assert.ok(result.includes("<!-- pmd: new -->"))
    assert.ok(!result.includes("stuff"))
  })
})

const { checkInjectionStatus, recordInjection } = await import("../src/core/dedup.js")

describe("dedup", () => {
  it("checkInjectionStatus returns new for fresh content", () => {
    const status = checkInjectionStatus("test-session", "crew-status", "some content")
    assert.equal(status, "new")
  })

  it("checkInjectionStatus returns unchanged for repeated content", () => {
    recordInjection("test-session-dup", "crew-status", "unchanged content")
    const status = checkInjectionStatus("test-session-dup", "crew-status", "unchanged content")
    assert.equal(status, "unchanged")
  })

  it("checkInjectionStatus detects changed content", () => {
    recordInjection("test-session-chg", "crew-status", "original content")
    const status = checkInjectionStatus("test-session-chg", "crew-status", "new content")
    assert.equal(status, "changed")
  })
})

after(() => {
  process.chdir(origDir)
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
})
