The `pmd doctor` command in `src/commands/doctor.ts` currently checks basic setup (Node version, config validity, daemon PID, template tags, script permissions). But it never actually runs scripts or renders blocks — so it can't detect silent failures.

Extend `pmd doctor` with these new checks:

1. **Script execution check** — For each `.sh` script found in `.pipemd/scripts/`, run it with a 3-second timeout. Report any scripts that:
   - Exit with a non-zero code (error)
   - Produce no stdout output (empty)
   - Exceed the timeout

2. **Block rendering check** — For each `<!-- pmd:block-name -->` tag in `.pipemd/template.md`, attempt to resolve/render it. Report blocks that:
   - Return errors
   - Return empty output

3. **`--json` flag** — Add a `--json` option that outputs all check results (existing + new) as a single valid JSON object to stdout, for CI/CD integration.

Keep all existing checks working. Make sure `npx tsc --noEmit` passes and `pmd doctor` still runs without crashing.
