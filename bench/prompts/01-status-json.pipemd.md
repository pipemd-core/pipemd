Add a `--format json` flag to the `pmd status` command.

Requirements:
- Modify the existing `pmd status` command in `src/commands/status.ts`
- Add a `--format` option that accepts `"text"` (default) or `"json"`
- When `--format json` is passed, output a single JSON object to stdout with:
  - `running`: boolean (whether the daemon process is alive)
  - `pid`: number or null (from .daemon.pid)
  - `uptime_ms`: number or null (time since daemon started, computed from pid file mtime)
  - `version`: string (from package.json version)
  - `pipes`: number of configured pipes from config.yml
  - `lastRender_ms`: number or null (mtime of the output file, e.g., AGENTS.md)
  - `injectStats`: object or null (from .pipemd/.inject-stats.json if it exists)
- The JSON output must be valid and parseable with `JSON.parse()`
- When `--format text` (default), keep the existing human-readable output unchanged
- Follow the existing command patterns in the codebase (Commander `.option()` + `.action()`)
- The command should still exit 0 on success, exit 1 if daemon is not running AND --format text (json should still output the object with running: false)
