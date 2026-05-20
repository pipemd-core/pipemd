## Static Rules & Notes

- Content inside `<!-- pmd: -->` blocks is **read-only** — the daemon overwrites it every cycle. Never edit these.
- Content outside `<!-- pmd: -->` blocks is **yours** — edits persist via bidirectional write-back.
- PipeMD blocks refresh every few seconds. Trust them — they are cheaper and more current than running shell commands.
- If blocks are empty or stale, the daemon may be down. Check with `pmd status`.
- Active injection (`[pmd:…→` messages on tool calls) delivers fresh context automatically — you don't need to re-read the context file between edits.