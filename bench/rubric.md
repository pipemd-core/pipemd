# PipeMD Agent Benchmark — Quality Rubric

Each scenario is graded on a 0–2 quality scale. The grade determines whether
a run's efficiency metrics are comparable to other runs at the same quality
level.

## Grade 2 — Complete

The implementation:

- Passes `tsc --noEmit` with zero errors
- Contains no obvious logic errors (the feature does what was asked)
- Follows the project's existing patterns and conventions
- Does not break existing functionality (existing tests still pass if runnable)
- All files created/modified are syntactically valid

## Grade 1 — Partial

The implementation:

- Passes `tsc --noEmit` (compiles)
- Partially implements the requested feature (e.g., missing an edge case,
  incomplete integration)
- OR compiles but has a minor pattern violation (e.g., doesn't follow the
  exact middleware signature convention)

## Grade 0 — Broken

The implementation:

- Does not compile (`tsc --noEmit` fails)
- OR creates syntax errors in existing files
- OR is missing entirely (agent didn't produce the output)
- OR modifies files in a way that breaks the project structure

## Quality Check Process

Each scenario has a `quality/check-XX.sh` script that:

1. Runs `tsc --noEmit` in the worktree
2. Checks for the presence of required new files/exports
3. Verifies the feature integrates correctly (e.g., middleware is wired,
  command is registered)
4. Outputs a single integer grade (0, 1, or 2)

## Reporting Rule

Efficiency metrics (tokens, tool calls, wall time) are **only compared**
between runs that achieved the same quality grade. A Grade-0 run with 8 tool
calls does not "beat" a Grade-2 run with 22 tool calls.
