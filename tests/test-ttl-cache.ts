import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { TtlCache } from "../src/core/ttl-cache.js"

describe("TtlCache", () => {
  it("returns null when empty", () => {
    const cache = new TtlCache<string>(1000)
    assert.equal(cache.get(), null)
  })

  it("stores and retrieves a value", () => {
    const cache = new TtlCache<string>(1000)
    cache.set("hello")
    assert.equal(cache.get(), "hello")
  })

  it("stores and retrieves non-string types", () => {
    const cache = new TtlCache<number[]>(5000)
    cache.set([1, 2, 3])
    assert.deepEqual(cache.get(), [1, 2, 3])
  })

  it("overwrites previous value", () => {
    const cache = new TtlCache<string>(1000)
    cache.set("first")
    cache.set("second")
    assert.equal(cache.get(), "second")
  })

  it("invalidate clears the value", () => {
    const cache = new TtlCache<string>(1000)
    cache.set("hello")
    cache.invalidate()
    assert.equal(cache.get(), null)
  })

  it("invalidate on empty cache is a no-op", () => {
    const cache = new TtlCache<string>(1000)
    assert.doesNotThrow(() => cache.invalidate())
    assert.equal(cache.get(), null)
  })

  it("value expires after TTL", () => {
    const cache = new TtlCache<string>(1)
    cache.set("expires-fast")
    const start = Date.now()
    while (Date.now() - start < 5) {}
    assert.equal(cache.get(), null)
  })

  it("set refreshes the TTL", () => {
    const cache = new TtlCache<number>(50)
    cache.set(1)
    const start = Date.now()
    while (Date.now() - start < 20) {}
    cache.set(2)
    const start2 = Date.now()
    while (Date.now() - start2 < 35) {}
    assert.equal(cache.get(), 2)
  })

  it("can store falsy values like zero", () => {
    const cache = new TtlCache<number>(1000)
    cache.set(0)
    assert.equal(cache.get(), 0)
  })

  it("can store empty string", () => {
    const cache = new TtlCache<string>(1000)
    cache.set("")
    assert.equal(cache.get(), "")
  })

  it("can store false boolean", () => {
    const cache = new TtlCache<boolean>(1000)
    cache.set(false)
    assert.equal(cache.get(), false)
  })

  it("can store null explicitly", () => {
    const cache = new TtlCache<string | null>(1000)
    cache.set(null)
    assert.equal(cache.get(), null)
  })

  it("get can be called multiple times while valid", () => {
    const cache = new TtlCache<string>(5000)
    cache.set("persistent")
    assert.equal(cache.get(), "persistent")
    assert.equal(cache.get(), "persistent")
    assert.equal(cache.get(), "persistent")
  })

  it("invalidate then set works", () => {
    const cache = new TtlCache<string>(1000)
    cache.set("first")
    cache.invalidate()
    assert.equal(cache.get(), null)
    cache.set("second")
    assert.equal(cache.get(), "second")
  })

  it("set over expired value revives cache", () => {
    const cache = new TtlCache<string>(1)
    cache.set("first")
    const start = Date.now()
    while (Date.now() - start < 5) {}
    assert.equal(cache.get(), null)
    cache.set("revived")
    assert.equal(cache.get(), "revived")
  })
})
