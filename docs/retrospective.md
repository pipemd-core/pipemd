# PipeMD Retrospective Prompt

Paste this after an agent completes a task using PipeMD context.

---

```
## PipeMD Retrospective

You just completed a task using PipeMD context. Give honest, concise feedback.

### What worked
- Which pmd: blocks were actually useful? Which did you ignore?
- Did active injection ([pmd:→ messages) deliver relevant context at the right time?
- Did the decision tree guide your workflow well?

### What didn't work
- Did you run shell commands that a block should have covered? Which ones?
- Were blocks stale, empty, or missing data you needed?
- Did any block return misleading or incomplete results? (e.g., wrong framework detection, missing files)
- Did injection fire at wrong times or deliver irrelevant content?

### Gaps
- What did you need that no block provided?
- Were there moments you had to explore the codebase manually for something that should have been in context?
- Any block that felt like wasted tokens?
- For ecosystem-specific blocks (angular-routes, react-components, etc.): did they detect your project's patterns correctly? If not, what patterns were missed?

### Token cost
- Roughly how many tokens did the blocks consume vs how useful were they? (high/medium/low value per block)

### Format
Respond as a numbered list. Be brutally honest — flattery is useless. Skip sections where you have nothing to report. One sentence per point max.
```

## Known Issues (from past retrospectives)

These issues have been reported and should be checked for recurrence:

| Issue | Fixed? | Check |
|---|---|---|
| `todos` block scanned build artifacts (`.angular/cache/`, `dist/`) | Yes — added default excludes | Verify no noise from build dirs |
| `angular-routes` only detected NgModule-based routing, missed standalone `*.routes.ts` | Yes — now detects both | Verify standalone route detection works |
| `arch` block showed trivially small graph for large projects | Partially — raised `MAX_MODULES` from 40 to 80, `MAX_FILES` from 300 to 500 | Verify arch captures enough detail on 50+ file projects |
| `type-check` and `lint` blocks go stale mid-session | Expected — blocks refresh on daemon cycle, not on every file change | Note if staleness caused real problems |
| Active injection never fired during session | Under investigation | Report if it works or not |
