Users of this Hono project report that returning an object containing a `Date` from `c.json()` fails to type-check, even though it works correctly at runtime (the `Date` serializes to an ISO string the way `JSON.stringify` already handles it). For example:

    app.get('/test', (c) => {
      return c.json({ createdAt: new Date() })
    }

…fails to compile, with TypeScript reporting that `Date` is not assignable to the framework's `JSONValue` / `JSONObject` / `JSONPrimitive` types.

Investigate where Hono defines the JSON-response value types and the `Context.json` signature, and fix it so `c.json()` accepts objects containing `Date` values, accurately reflecting what JSON serialization actually accepts at runtime.

Contract (how correctness is graded):
- After your fix, `c.json({ createdAt: new Date() })` must type-check cleanly.
- Do NOT broaden the types to `any` or silence the error with casts — the JSON value types should precisely describe what `JSON.stringify` accepts (which includes `Date`).
- Don't break the framework's existing typing: the fix should be minimal and targeted at the JSON value types and/or the `json()` return signature.

Correctness is checked by type-checking a bench-owned spec that calls `c.json(...)` with a `Date` value against your edited source; `npx tsc --noEmit` (strict) on that spec must pass.
