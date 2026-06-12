Add a response cache middleware to this Hono project.

Requirements:
- Create a new file at `src/middleware/response-cache/index.ts` (follow the barrel export pattern from existing middleware like `src/middleware/powered-by/`)
- The middleware should be a factory function called `responseCache` that accepts an optional options object: `{ maxEntries?: number, ttlMs?: number }` (defaults: maxEntries=100, ttlMs=60000)
- For every GET request, the middleware should:
  1. Build a cache key from the request URL
  2. If a cached response exists and hasn't expired, return it immediately (clone the cached Response)
  3. Otherwise, call `next()`, then cache the response (only if status is 200 and Content-Type is text or JSON)
  4. Set an `X-Cache` response header: `HIT` for cached responses, `MISS` for fresh ones
- Use an in-memory Map for the cache store (no external dependencies)
- Export the function so it can be used as `import { responseCache } from './response-cache'` or `app.use(responseCache())`
- Follow the exact same patterns as the existing `powered-by` and `logger` middleware in `src/middleware/`
- The middleware should work when registered globally: `app.use(responseCache())
