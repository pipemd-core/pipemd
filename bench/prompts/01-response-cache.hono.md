Users of this Hono project want repeated identical GET requests to be served from memory instead of recomputing them every time.

Add an in-memory response cache for successful `GET` responses. It should be a middleware factory that callers register globally, e.g. `app.use(responseCache())`, and should honour two tunables: a maximum number of cached entries and a time-to-live. Cached responses must be returned on a cache hit; otherwise the downstream handler runs and its response is stored for subsequent hits. Pick the defaults yourself.

Public API contract (the integration point callers depend on):
- Expose `export function responseCache(options?)`, importable as `import { responseCache } from '@/src/middleware/response-cache'` (a `response-cache` module under `src/middleware/`).
- `options` is an optional object with exactly these keys: `{ maxEntries?: number; ttlMs?: number }` — `maxEntries` caps the number of cached entries (evict oldest when exceeded), `ttlMs` is the time-to-live in milliseconds (entries are not served after it elapses). Callers will pass these key names verbatim.

Beyond this contract, decide the file layout and internal structure yourself by studying the existing middleware in `src/middleware/` to learn the project's factory / `MiddlewareHandler` conventions and code style, and follow them. Do not add any new external dependencies.

Correctness will be checked with a vitest spec that imports `responseCache` and verifies: a repeated GET to the same URL returns a cached body, a different URL is not a hit, and an entry is not served after its TTL has elapsed. `npx tsc --noEmit` must pass.
