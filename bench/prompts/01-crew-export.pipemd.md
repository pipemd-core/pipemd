Add a new CLI subcommand `pmd crew export` that outputs all active crew sessions as JSON to stdout.

Requirements:
- The command should be registered as `crew export` under the existing `pmd crew` command group
- Output a JSON array of all active crew sessions, each containing: session ID, role, harness, label (if set), pid, coordinatorId, claimedFiles (array of {path, claimedAt}), note, startedAt, lastHeartbeat
- Include a header comment with the total session count
- Exit 0 on success, exit 1 if no sessions exist (with a message "No active crew sessions")
- Follow the existing command patterns in `src/commands/crew.ts` and other command files
- Use the existing crew session reading functions — do not duplicate file reading logic
