Add a request timing middleware to this Hono project.

Requirements:
- Create a new file at `src/middleware/timing/index.ts` (with a barrel export from `src/middleware/timing/tsconfig.json` if needed, or just the index file)
- The middleware should be a factory function called `timing` that accepts an optional options object: `{ headerName?: string }` (default header: `X-Response-Time`)
- For every request, the middleware should:
  1. Record the start time before calling `next()`
  2. After `next()` returns, compute the elapsed time in milliseconds
  3. Set the response header with the elapsed time (e.g., `X-Response-Time: 12ms`)
- Follow the exact same patterns as the existing `poweredBy` and `logger` middleware in `src/middleware/`
- Export the function so it can be used as `import { timing } from './timing'` or `app.use(timing())`
- The middleware should work when registered globally: `app.use(timing())`
