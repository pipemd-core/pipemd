#### 4. Coordinate — Multi-Agent & Crew Protocol

**If a `crew` block is present, you are not alone.** Other agents may be editing the same codebase simultaneously.

**Before editing any file:**

1. Read the `crew` block. It lists every active session, their claimed files, and any conflicts.
2. If the file is claimed by another agent (`⚠️ CONFLICT`), **stop**. Coordinate with that agent or pick different work.
3. If edit hooks are installed, claims happen automatically on every file edit. If not, claim manually:
   ```bash
   pmd crew claim src/auth.ts --note "refactoring login"
   ```
4. Post your intent so others can see it:
   ```bash
   pmd crew note "rewriting the auth middleware"
   ```

**Sub-agents and parallel workers:**

- PipeMD uses a **Harness → Coordinator → Worker** hierarchy. Each harness has one coordinator; workers are sub-agents spawned for parallel tasks.
- If you are a coordinator spawning sub-agents:
  - Each worker must `pmd crew join --role worker` and export `PMD_SESSION` to get its own session.
  - Partition work by file or directory to minimize overlap.
  - Monitor the `crew` block for conflicts between your workers. Resolve immediately.
- If you are a worker:
  - Claim only the files assigned to you.
  - Check the `crew` block before every edit.
  - Release files when done: `pmd crew release src/auth.ts`.

**Staleness and cleanup:**

- Sessions without a heartbeat for 90 seconds are considered stale.
- Clean up when you're done: `pmd crew leave` removes your session entirely.

**Cross-harness coordination:**

- PipeMD is harness-neutral. Claude Code, OpenCode, Gemini, Aider, and Cursor agents all share the same crew ledger.
- The `crew` block renders the union of all sessions — you see everyone, regardless of their harness.
