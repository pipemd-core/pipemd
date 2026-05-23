import assert from "node:assert/strict"
import {
  parseInjectionConfig,
  computePayloadHash,
  getRulesForTrigger,
  DEFAULT_ACTIVE_RULES,
} from "../src/core/injection-types.js"
import type { InjectionConfig, InjectionTrigger } from "../src/core/injection-types.js"

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
    failed++
  }
}

console.log("\x1b[1;33m═══ Injection Types Unit Tests ═══\x1b[0m\n")

// ── parseInjectionConfig ──

test("null input returns default active rules", () => {
  const result = parseInjectionConfig(null)
  assert.deepStrictEqual(result, DEFAULT_ACTIVE_RULES)
})

test("undefined input returns default active rules", () => {
  const result = parseInjectionConfig(undefined)
  assert.deepStrictEqual(result, DEFAULT_ACTIVE_RULES)
})

test("non-object input returns default active rules", () => {
  const result = parseInjectionConfig("hello")
  assert.deepStrictEqual(result, DEFAULT_ACTIVE_RULES)
})

test("passive delivery returns passive config with empty rules", () => {
  const result = parseInjectionConfig({ delivery: "passive" })
  assert.strictEqual(result.delivery, "passive")
  assert.deepStrictEqual(result.rules, {})
})

test("active delivery with no rules returns default active rules", () => {
  const result = parseInjectionConfig({ delivery: "active" })
  assert.deepStrictEqual(result, DEFAULT_ACTIVE_RULES)
})

test("expert delivery with custom rules returns those rules", () => {
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

test("invalid delivery mode falls back to active with defaults", () => {
  const result = parseInjectionConfig({ delivery: "unknown-mode" })
  assert.deepStrictEqual(result, DEFAULT_ACTIVE_RULES)
})

test("invalid trigger names are ignored", () => {
  const result = parseInjectionConfig({
    delivery: "expert",
    rules: {
      "fake-trigger": [{ source: "custom", scope: "global" }],
    },
  })
  assert.strictEqual(result.delivery, "expert")
  assert.deepStrictEqual(result.rules, {})
})

test("invalid sources in rules are filtered out", () => {
  const result = parseInjectionConfig({
    delivery: "expert",
    rules: {
      "before-read": [{ source: "invalid-source", scope: "global" }],
    },
  })
  assert.strictEqual(result.delivery, "expert")
  assert.ok(!result.rules["before-read"])
})

test("invalid scopes in rules are filtered out", () => {
  const result = parseInjectionConfig({
    delivery: "expert",
    rules: {
      "before-read": [{ source: "custom", scope: "invalid-scope" }],
    },
  })
  assert.strictEqual(result.delivery, "expert")
  assert.ok(!result.rules["before-read"])
})

test("max-lines: negative number filters the rule", () => {
  const result = parseInjectionConfig({
    delivery: "expert",
    rules: {
      "before-read": [{ source: "custom", scope: "global", "max-lines": -5 }],
    },
  })
  assert.strictEqual(result.delivery, "expert")
  assert.ok(!result.rules["before-read"])
})

test("max-lines: zero filters the rule", () => {
  const result = parseInjectionConfig({
    delivery: "expert",
    rules: {
      "before-read": [{ source: "custom", scope: "global", "max-lines": 0 }],
    },
  })
  assert.strictEqual(result.delivery, "expert")
  assert.ok(!result.rules["before-read"])
})

test("max-lines: non-number filters the rule", () => {
  const result = parseInjectionConfig({
    delivery: "expert",
    rules: {
      "before-read": [{ source: "custom", scope: "global", "max-lines": "abc" }],
    },
  })
  assert.strictEqual(result.delivery, "expert")
  assert.ok(!result.rules["before-read"])
})

test("async: non-boolean filters the rule", () => {
  const result = parseInjectionConfig({
    delivery: "expert",
    rules: {
      "before-read": [{ source: "custom", scope: "global", async: "yes" }],
    },
  })
  assert.strictEqual(result.delivery, "expert")
  assert.ok(!result.rules["before-read"])
})

test("command: non-string filters the rule", () => {
  const result = parseInjectionConfig({
    delivery: "expert",
    rules: {
      "before-read": [{ source: "custom", scope: "global", command: 123 }],
    },
  })
  assert.strictEqual(result.delivery, "expert")
  assert.ok(!result.rules["before-read"])
})

test("label: non-string filters the rule", () => {
  const result = parseInjectionConfig({
    delivery: "expert",
    rules: {
      "before-read": [{ source: "custom", scope: "global", label: true }],
    },
  })
  assert.strictEqual(result.delivery, "expert")
  assert.ok(!result.rules["before-read"])
})

test("mixed valid and invalid rules in same trigger keeps valid ones", () => {
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

test("rules from multiple triggers preserved", () => {
  const result = parseInjectionConfig({
    delivery: "expert",
    rules: {
      "before-read": [{ source: "custom", scope: "global" }],
      "after-edit": [{ source: "validate-file", scope: "target-file", "max-lines": 10 }],
      "on-idle": [{ source: "git-delta", scope: "global" }],
    },
  })
  assert.strictEqual(result.delivery, "expert")
  assert.strictEqual(result.rules["before-read"]!.length, 1)
  assert.strictEqual(result.rules["after-edit"]!.length, 1)
  assert.strictEqual(result.rules["on-idle"]!.length, 1)
  assert.strictEqual(result.rules["after-edit"]![0]["max-lines"], 10)
})

test("expert with empty valid rules array returns expert with empty rules", () => {
  const result = parseInjectionConfig({
    delivery: "expert",
    rules: {
      "before-read": [],
    },
  })
  assert.strictEqual(result.delivery, "expert")
  assert.deepStrictEqual(result.rules, {})
})

test("active delivery with all rules filtered falls back to defaults", () => {
  const result = parseInjectionConfig({
    delivery: "active",
    rules: {
      "before-read": [{ source: "invalid-source", scope: "global" }],
    },
  })
  assert.deepStrictEqual(result, DEFAULT_ACTIVE_RULES)
})

// ── computePayloadHash ──

test("same input produces same hash", () => {
  const a = computePayloadHash("hello world")
  const b = computePayloadHash("hello world")
  assert.strictEqual(a, b)
})

test("different input produces different hash", () => {
  const a = computePayloadHash("hello")
  const b = computePayloadHash("world")
  assert.notStrictEqual(a, b)
})

test("hash is 16 characters", () => {
  const hash = computePayloadHash("test content")
  assert.strictEqual(hash.length, 16)
})

// ── getRulesForTrigger ──

test("returns rules for known trigger", () => {
  const rules = getRulesForTrigger(DEFAULT_ACTIVE_RULES, "before-edit")
  assert.ok(rules.length > 0)
  assert.strictEqual(rules[0].source, "crew-locks")
})

test("returns empty array for trigger with no rules", () => {
  const config: InjectionConfig = { delivery: "expert", rules: { "before-read": [{ source: "custom", scope: "global" }] } }
  const rules = getRulesForTrigger(config, "on-idle")
  assert.deepStrictEqual(rules, [])
})

test("returns empty array for undefined trigger", () => {
  const config: InjectionConfig = { delivery: "passive", rules: {} }
  const rules = getRulesForTrigger(config, "before-read")
  assert.deepStrictEqual(rules, [])
})

console.log("")
console.log("\x1b[1;33m═══ Results ═══\x1b[0m")
console.log(`  \x1b[32mPASS\x1b[0m: ${passed}`)
console.log(`  \x1b[31mFAIL\x1b[0m: ${failed}`)
if (failed > 0) process.exit(1)
else console.log(`\n\x1b[32m✔ All injection-types tests passed\x1b[0m`)
