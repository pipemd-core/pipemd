Write an `AGENTS.md` file at the project root for this repository, then STOP.

`AGENTS.md` is a brief, static orientation file that an AI coding agent reads before working on the repo. It must be **hand-written-style documentation** — NOT generated telemetry, NOT containing any `<!-- pmd: -->` markers, NOT auto-refreshed. Think of what a thoughtful maintainer would write so a new contributor (human or AI) can be productive in 5 minutes.

Explore the repository first (read the README, the package/manifest file, the test/build config, and 2-3 representative source files), then author `AGENTS.md` with exactly these sections and nothing more:

1. **One-line purpose** of the project.
2. **Repository layout** — 4-8 bullet points naming the key directories/files and what they hold.
3. **Build / test / lint commands** — the EXACT shell commands for THIS project's native toolchain (e.g. `tsc --noEmit`, `vitest run`, `pytest -q`, `lua <file>`, `go test ./...`, `gofmt -l *.go`, `ruff check src/`). Infer them from the manifest and configs you read. If a command needs a path/env (e.g. `PYTHONPATH=src`), include it.
4. **Key conventions** — 3-5 bullets: language version, import/module style, naming, where new code should go, anything a stranger would get wrong on first guess.

Rules:
- Keep it under 60 lines total. Be terse and concrete.
- No code examples longer than one line. No installation instructions. No license info.
- Do NOT use any `<!-- pmd: -->` markers. Do NOT mention PipeMD.
- Do NOT modify any file other than creating `AGENTS.md`.
- Write the file, confirm it exists, and finish.
