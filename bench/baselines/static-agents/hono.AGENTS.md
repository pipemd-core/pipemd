# AGENTS.md

## Purpose
Hono — a small, fast, multi-runtime web framework built on Web Standards; the same code runs on Cloudflare Workers, Deno, Bun, and Node.js.

## Repository layout
- `src/index.ts` — public entry point (re-exports `Hono` + types); the `Hono` class lives in `src/hono-base.ts`, request/context logic in `src/request.ts` / `src/context.ts`.
- `src/router/` — pluggable routers: `reg-exp-router` (default, fast), `smart-router`, `trie-router`, `linear-router`, `pattern-router`.
- `src/middleware/`, `src/helper/`, `src/utils/`, `src/validator/` — built-in middleware, helpers, low-level utilities, request validators.
- `src/adapter/` — runtime-specific adapters (`cloudflare-workers`, `deno`, `bun`, `aws-lambda`, `vercel`, `netlify`, `service-worker`, …); core stays runtime-agnostic.
- `src/jsx/` — built-in JSX renderer (custom `jsx`/`Fragment` factories) plus the `jsx/dom` client renderer.
- `runtime-tests/` — per-runtime vitest projects; `build/` — esbuild-based bundling (`build.ts`); `benchmarks/` + `perf-measures/` — perf harnesses.
- `package.json`, `jsr.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`, `.prettierrc` — toolchain config (published to both npm and JSR).

## Build / test / lint commands
Bun is the package manager. Run from repo root:
- Type-check + unit tests: `bun run test` → `tsc --noEmit && vitest --run`
- Tests only / watch: `bunx vitest --run` / `bunx vitest --watch`
- Runtime-specific suites: `bun run test:node`, `bun run test:bun`, `bun run test:deno`, `bun run test:workerd`, `bun run test:fastly`
- Lint / fix: `bun run lint` / `bun run lint:fix` (eslint over `src runtime-tests build perf-measures benchmarks`)
- Format check / fix: `bun run format` / `bun run format:fix` (prettier)
- Build to `dist/`: `bun run build` (esbuild via `build/build.ts`)
- Coverage: `bun run coverage`

## Key conventions
- TypeScript, strict mode, `target: ES2022`, `moduleResolution: Bundler`; `engines.node >= 16.9.0`.
- Formatting: no semicolons, single quotes, 100-col width, 2-space indent, trailing comma `es5`, LF — enforced by prettier.
- Tests are colocated with source (`foo.ts` + `foo.test.ts` / `.test.tsx`, also `.spec.*`), vitest globals enabled. Put new code under the matching `src/<area>/` subfolder.
- Core depends only on Web Standards APIs (Request/Response, fetch, crypto, streams); any runtime-specific code goes in `src/adapter/<runtime>` and is selected via the adapter entry points.
- JSX uses custom factories `jsx` and `Fragment` (see `tsconfig.json`); test `.tsx` compiles through esbuild's automatic runtime pointing at `./src/jsx`.
- Each published subpath in `package.json` `exports` has a matching entry in `jsr.json`; keep the two in sync when adding an export.
