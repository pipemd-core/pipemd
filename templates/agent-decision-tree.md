### Agent Decision Tree

You are operating inside a PipeMD context file. The `<!-- pmd: -->` blocks below are live data refreshed by the daemon.

---

#### 1. Context Gathering — Read Before You Act

Before writing code, gather your bearings from the blocks below.

| You need… | Read this block |
|---|---|
| Project structure, find a file | `tree` |
| Dependencies and versions | `deps` |
| Exported symbols, env vars | `exports` |
| Branch, recent commits, changes | `git-context` |
| Type errors | `type-check` |
| Lint errors | `lint` |

If the answer isn't in the blocks — then run the appropriate shell command.

---

#### 2. Edit — Surgical Discipline

- **Match existing code style.** Imports, naming, formatting, conventions — follow what's already there.
- **One concern per edit.** If you spot unrelated issues, mention them but don't fix them unless asked.
- **No logic duplication.** Don't duplicate logic or create parallel states if a source of truth already exists.
- **No speculative code.** No features beyond what was asked. No abstractions for single-use code. If you write 200 lines and it could be 50, rewrite it.
- **Never edit inside `<!-- pmd: -->` blocks** — your changes are overwritten on the next daemon cycle.

---

#### 3. Verify — Close the Loop

- **Run the project's verification suite.** Check the `deps` block for the correct commands. Typical order: lint → typecheck → test → build.
- **Re-read the quality blocks.** After your edits, check `type-check` and `lint` blocks for new errors.
- **Committing?** `git diff --cached` is the only git command you need. Stage your files, review the diff, then commit.
