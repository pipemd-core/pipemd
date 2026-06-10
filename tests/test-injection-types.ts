import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import {
  parseInjectionConfig,
  computePayloadHash,
  getRulesForTrigger,
  findInjectionConfigIssues,
  generateInjectionYml,
  DEFAULT_ACTIVE_RULES,
} from "../src/core/injection-types.js"
import type { InjectionConfig } from "../src/core/injection-types.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

describe("parseInjectionConfig", () => {
  it("null input returns default active rules", () => {
    const result = parseInjectionConfig(null)
    assert.deepStrictEqual(result, DEFAULT_ACTIVE_RULES)
  })

  it("undefined input returns default active rules", () => {
    const result = parseInjectionConfig(undefined)
    assert.deepStrictEqual(result, DEFAULT_ACTIVE_RULES)
  })

  it("non-object input returns default active rules", () => {
    const result = parseInjectionConfig("hello")
    assert.deepStrictEqual(result, DEFAULT_ACTIVE_RULES)
  })

  it("passive delivery returns passive config with empty rules", () => {
    const result = parseInjectionConfig({ delivery: "passive" })
    assert.strictEqual(result.delivery, "passive")
    assert.deepStrictEqual(result.rules, {})
  })

  it("active delivery with no rules returns default active rules", () => {
    const result = parseInjectionConfig({ delivery: "active" })
    assert.deepStrictEqual(result, DEFAULT_ACTIVE_RULES)
  })

  it("expert delivery with custom rules returns those rules", () => {
    const custom = {
      delivery: "expert",
      rules: {
        "before-read": [
          { source: "custom", scope: "global", command: "echo hi", label: "test" },
        ],
      },
    }
    const result = parseInjectionConfig(custom)
    assert.strictEqual(result.delivery, "expert")
    assert.ok(result.rules["before-read"])
    assert.strictEqual(result.rules["before-read"]!.length, 1)
    assert.strictEqual(result.rules["before-read"]![0].source, "custom")
    assert.strictEqual(result.rules["before-read"]![0].command, "echo hi")
    assert.strictEqual(result.rules["before-read"]![0].label, "test")
  })

  it("invalid delivery mode falls back to active with defaults", () => {
    const result = parseInjectionConfig({ delivery: "unknown-mode" })
    assert.deepStrictEqual(result, DEFAULT_ACTIVE_RULES)
  })

  it("invalid trigger names are ignored", () => {
    const result = parseInjectionConfig({
      delivery: "expert",
      rules: {
        "fake-trigger": [{ source: "custom", scope: "global" }],
      },
    })
    assert.strictEqual(result.delivery, "expert")
    assert.deepStrictEqual(result.rules, {})
  })

  it("invalid sources in rules are filtered out", () => {
    const result = parseInjectionConfig({
      delivery: "expert",
      rules: {
        "before-read": [{ source: "invalid-source", scope: "global" }],
      },
    })
    assert.strictEqual(result.delivery, "expert")
    assert.ok(!result.rules["before-read"])
  })

  it("invalid scopes in rules are filtered out", () => {
    const result = parseInjectionConfig({
      delivery: "expert",
      rules: {
        "before-read": [{ source: "custom", scope: "invalid-scope" }],
      },
    })
    assert.strictEqual(result.delivery, "expert")
    assert.ok(!result.rules["before-read"])
  })

  it("max-lines: negative number filters the rule", () => {
    const result = parseInjectionConfig({
      delivery: "expert",
      rules: {
        "before-read": [{ source: "custom", scope: "global", "max-lines": -5 }],
      },
    })
    assert.strictEqual(result.delivery, "expert")
    assert.ok(!result.rules["before-read"])
  })

  it("max-lines: zero filters the rule", () => {
    const result = parseInjectionConfig({
      delivery: "expert",
      rules: {
        "before-read": [{ source: "custom", scope: "global", "max-lines": 0 }],
      },
    })
    assert.strictEqual(result.delivery, "expert")
    assert.ok(!result.rules["before-read"])
  })

  it("max-lines: non-number filters the rule", () => {
    const result = parseInjectionConfig({
      delivery: "expert",
      rules: {
        "before-read": [{ source: "custom", scope: "global", "max-lines": "abc" }],
      },
    })
    assert.strictEqual(result.delivery, "expert")
    assert.ok(!result.rules["before-read"])
  })

  it("async: non-boolean filters the rule", () => {
    const result = parseInjectionConfig({
      delivery: "expert",
      rules: {
        "before-read": [{ source: "custom", scope: "global", async: "yes" }],
      },
    })
    assert.strictEqual(result.delivery, "expert")
    assert.ok(!result.rules["before-read"])
  })

  it("command: non-string filters the rule", () => {
    const result = parseInjectionConfig({
      delivery: "expert",
      rules: {
        "before-read": [{ source: "custom", scope: "global", command: 123 }],
      },
    })
    assert.strictEqual(result.delivery, "expert")
    assert.ok(!result.rules["before-read"])
  })

  it("label: non-string filters the rule", () => {
    const result = parseInjectionConfig({
      delivery: "expert",
      rules: {
        "before-read": [{ source: "custom", scope: "global", label: true }],
      },
    })
    assert.strictEqual(result.delivery, "expert")
    assert.ok(!result.rules["before-read"])
  })

  it("mixed valid and invalid rules in same trigger keeps valid ones", () => {
    const result = parseInjectionConfig({
      delivery: "expert",
      rules: {
        "before-read": [
          { source: "invalid-source", scope: "global" },
          { source: "custom", scope: "global" },
          { source: "custom", scope: "bad-scope" },
          { source: "crew-status", scope: "target-file", "max-lines": 3 },
        ],
      },
    })
    assert.strictEqual(result.delivery, "expert")
    assert.strictEqual(result.rules["before-read"]!.length, 2)
    assert.strictEqual(result.rules["before-read"]![0].source, "custom")
    assert.strictEqual(result.rules["before-read"]![1].source, "crew-status")
  })

  it("rules from multiple triggers preserved", () => {
    const result = parseInjectionConfig({
      delivery: "expert",
      rules: {
        "before-read": [{ source: "custom", scope: "global" }],
        "after-edit": [{ source: "file-errors", scope: "target-file", "max-lines": 10 }],
        "on-idle": [{ source: "git-delta", scope: "global" }],
      },
    })
    assert.strictEqual(result.delivery, "expert")
    assert.strictEqual(result.rules["before-read"]!.length, 1)
    assert.strictEqual(result.rules["after-edit"]!.length, 1)
    assert.strictEqual(result.rules["on-idle"]!.length, 1)
    assert.strictEqual(result.rules["after-edit"]![0]["max-lines"], 10)
  })

  it("expert with empty valid rules array returns expert with empty rules", () => {
    const result = parseInjectionConfig({
      delivery: "expert",
      rules: {
        "before-read": [],
      },
    })
    assert.strictEqual(result.delivery, "expert")
    assert.deepStrictEqual(result.rules, {})
  })

  it("active delivery with all rules filtered falls back to defaults", () => {
    const result = parseInjectionConfig({
      delivery: "active",
      rules: {
        "before-read": [{ source: "invalid-source", scope: "global" }],
      },
    })
    assert.deepStrictEqual(result, DEFAULT_ACTIVE_RULES)
  })
})

describe("computePayloadHash", () => {
  it("same input produces same hash", () => {
    const a = computePayloadHash("hello world")
    const b = computePayloadHash("hello world")
    assert.strictEqual(a, b)
  })

  it("different input produces different hash", () => {
    const a = computePayloadHash("hello")
    const b = computePayloadHash("world")
    assert.notStrictEqual(a, b)
  })

  it("hash is 16 characters", () => {
    const hash = computePayloadHash("test content")
    assert.strictEqual(hash.length, 16)
  })
})

describe("getRulesForTrigger", () => {
  it("returns rules for known trigger", () => {
    const rules = getRulesForTrigger(DEFAULT_ACTIVE_RULES, "before-edit")
    assert.ok(rules.length > 0)
    assert.strictEqual(rules[0].source, "crew-locks")
  })

  it("returns empty array for trigger with no rules", () => {
    const config: InjectionConfig = { delivery: "expert", rules: { "before-read": [{ source: "custom", scope: "global" }] } }
    const rules = getRulesForTrigger(config, "on-idle")
    assert.deepStrictEqual(rules, [])
  })

  it("returns empty array for undefined trigger", () => {
    const config: InjectionConfig = { delivery: "passive", rules: {} }
    const rules = getRulesForTrigger(config, "before-read")
    assert.deepStrictEqual(rules, [])
  })
})

describe("findInjectionConfigIssues", () => {
  it("clean config has no issues", () => {
    const clean = { delivery: "active", rules: { "before-read": [{ source: "crew-status", scope: "global" }] } }
    assert.deepStrictEqual(findInjectionConfigIssues(clean), [])
  })

  it("flags an unknown source", () => {
    const bad = { rules: { "before-read": [{ source: "context-rules", scope: "global" }] } }
    const issues = findInjectionConfigIssues(bad)
    assert.strictEqual(issues.length, 1)
    assert.match(issues[0], /unknown source "context-rules" in trigger "before-read"/)
  })

  it("flags an unknown trigger", () => {
    const bad = { rules: { "after-read": [{ source: "crew-status", scope: "global" }] } }
    assert.deepStrictEqual(findInjectionConfigIssues(bad), ['unknown trigger "after-read"'])
  })

  it("flags a removed top-level key", () => {
    const bad = { rules: {}, "context-files": [{ glob: "AGENTS.md" }] }
    assert.deepStrictEqual(findInjectionConfigIssues(bad), ['removed config key "context-files" is still present'])
  })

  it("the generated default config is clean", () => {
    const generated = parseYaml(generateInjectionYml(DEFAULT_ACTIVE_RULES))
    assert.deepStrictEqual(findInjectionConfigIssues(generated), [])
  })

  it("the repo's own .pipemd/injection.yml is clean", () => {
    const raw = parseYaml(readFileSync(path.join(repoRoot, ".pipemd", "injection.yml"), "utf-8"))
    assert.deepStrictEqual(findInjectionConfigIssues(raw), [])
  })
})
