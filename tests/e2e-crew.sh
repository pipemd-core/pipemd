#!/usr/bin/env bash
set -uo pipefail
# e2e-crew.sh — PipeMD Crew coordination layer end-to-end tests.
# Requires `pnpm build` first (exercises the real `pmd` binary).

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

assert_contains() {
  if echo "$1" | grep -qF -- "$2"; then
    echo -e "  ${GREEN}✓${NC} ${3:-output} contains: $2"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} ${3:-output} missing: $2"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  if echo "$1" | grep -qF -- "$2"; then
    echo -e "  ${RED}✖${NC} ${3:-output} should not contain: $2"
    FAIL=$((FAIL + 1))
  else
    echo -e "  ${GREEN}✓${NC} ${3:-output} excludes: $2"
    PASS=$((PASS + 1))
  fi
}

assert_eq() {
  if [ "$1" = "$2" ]; then
    echo -e "  ${GREEN}✓${NC} ${3:-value}: $1"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} ${3:-value}: expected '$2', got '$1'"
    FAIL=$((FAIL + 1))
  fi
}

assert_file() {
  if [ -e "$1" ]; then
    echo -e "  ${GREEN}✓${NC} file exists: $1"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} file missing: $1"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_contains() {
  if grep -qF -- "$2" "$1" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} ${3:-file} contains: $2"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} ${3:-file} missing: $2"
    FAIL=$((FAIL + 1))
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PMD="node $ROOT_DIR/dist/index.js"

if [ ! -f "$ROOT_DIR/dist/index.js" ]; then
  echo -e "${RED}✖ dist/index.js missing — run 'pnpm build' first.${NC}"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q
git config user.email t@t.co
git config user.name t
mkdir -p .pipemd src
printf 'version: "1.0"\ncommands:\n  crew: bash .pipemd/scripts/crew/crew.sh\npipes: []\ninjected: []\nsettings: {debounceMs: 3000, reServeDelayMs: 2000}\n' > .pipemd/config.yml

echo -e "${YELLOW}═══ PipeMD Crew E2E Tests ═══${NC}"

# ── join (coordinator) ──
echo -e "${YELLOW}Test: crew join${NC}"
OUT=$($PMD crew join --role coordinator --harness OpenCode --label main 2>&1)
assert_contains "$OUT" "coordinator registered" "join"
assert_contains "$OUT" "export PMD_SESSION=" "join"
COUNT=$(ls .pipemd/crew/ 2>/dev/null | wc -l)
assert_eq "$COUNT" "1" "ledger file count"
C=$(ls .pipemd/crew/ | sed 's/.json//')

# ── claim ──
echo -e "${YELLOW}Test: crew claim${NC}"
$PMD crew claim src/auth.ts --note "refactor login" >/dev/null 2>&1
LEDGER=$(cat ".pipemd/crew/$C.json")
assert_contains "$LEDGER" '"path": "src/auth.ts"' "ledger"
assert_contains "$LEDGER" '"role": "coordinator"' "ledger"

# ── render ──
echo -e "${YELLOW}Test: crew render${NC}"
OUT=$($PMD crew render 2>&1)
assert_contains "$OUT" "OpenCode" "render"
assert_contains "$OUT" "coordinator" "render"
assert_contains "$OUT" "src/auth.ts" "render"

# ── worker hierarchy ──
echo -e "${YELLOW}Test: coordinator hierarchy${NC}"
W1=$(PMD_CREW_ROLE=worker PMD_CREW_COORDINATOR=$C $PMD crew join --harness OpenCode --label agent-1 2>&1 | grep -oP 'cr_[0-9a-f]+' | head -1)
W2=$(PMD_CREW_ROLE=worker PMD_CREW_COORDINATOR=$C $PMD crew join --harness OpenCode --label agent-2 2>&1 | grep -oP 'cr_[0-9a-f]+' | head -1)
PMD_SESSION=$W1 $PMD crew claim src/login.ts --note "wiring" >/dev/null 2>&1
PMD_SESSION=$W2 $PMD crew claim src/db.ts >/dev/null 2>&1
OUT=$($PMD crew render 2>&1)
assert_contains "$OUT" "agent-1" "hierarchy"
assert_contains "$OUT" "agent-2" "hierarchy"
assert_contains "$OUT" "3 active session" "hierarchy"

# ── conflict detection ──
echo -e "${YELLOW}Test: conflict detection${NC}"
PMD_SESSION=$W2 $PMD crew claim src/login.ts >/dev/null 2>&1
OUT=$($PMD crew render 2>&1)
assert_contains "$OUT" "⚠️ CONFLICT" "conflict"
assert_contains "$OUT" "src/login.ts" "conflict"

# ── release ──
echo -e "${YELLOW}Test: crew release${NC}"
PMD_SESSION=$W2 $PMD crew release src/login.ts >/dev/null 2>&1
OUT=$($PMD crew render 2>&1)
assert_not_contains "$OUT" "CONFLICT" "after release"

# ── reaping stale sessions ──
echo -e "${YELLOW}Test: stale-session reaping${NC}"
printf '{"schema":1,"id":"cr_dead0001","role":"worker","harness":"Aider","pid":999999,"ppid":1,"coordinatorId":null,"claimedFiles":[],"startedAt":"2020-01-01T00:00:00Z","lastHeartbeat":"2020-01-01T00:00:00Z","cwd":"/tmp"}\n' > .pipemd/crew/cr_dead0001.json
OUT=$($PMD crew reap 2>&1)
assert_contains "$OUT" "cr_dead0001" "reap"
assert_not_contains "$(ls .pipemd/crew/)" "cr_dead0001" "ledger after reap"

# ── malformed ledger file is skipped, not fatal ──
echo -e "${YELLOW}Test: malformed ledger tolerance${NC}"
echo "{ this is not json" > .pipemd/crew/cr_broken.json
OUT=$($PMD crew render 2>&1)
assert_contains "$OUT" "👥 Crew" "render survives bad file"
rm -f .pipemd/crew/cr_broken.json

# ── leave ──
echo -e "${YELLOW}Test: crew leave${NC}"
PMD_SESSION=$W1 $PMD crew leave >/dev/null 2>&1
assert_not_contains "$(ls .pipemd/crew/)" "$W1" "ledger after leave"

# ── hook installer (idempotent) ──
echo -e "${YELLOW}Test: install-hooks (Claude Code)${NC}"
$PMD crew install-hooks --harness "Claude Code" >/dev/null 2>&1
assert_file ".claude/settings.json"
SETTINGS=$(cat .claude/settings.json)
assert_contains "$SETTINGS" "pmd crew claim" "settings"
assert_contains "$SETTINGS" "PostToolUse" "settings"
assert_contains "$SETTINGS" "SessionStart" "settings"
assert_contains "$SETTINGS" "SessionEnd" "settings"
assert_contains "$SETTINGS" "PreToolUse" "settings"
assert_contains "$SETTINGS" "SubagentStart" "settings"
assert_contains "$SETTINGS" "SubagentStop" "settings"
$PMD crew install-hooks --harness "Claude Code" >/dev/null 2>&1
HOOK_COUNT=$(grep -c "pmd crew claim" .claude/settings.json)
assert_eq "$HOOK_COUNT" "1" "claim hook count after re-run (idempotent)"

# ── statusline (Claude Code dev-side surface) ──
echo -e "${YELLOW}Test: statusline${NC}"
assert_contains "$(cat .claude/settings.json)" "pmd statusline" "statusLine registered"
SL_COUNT=$(grep -c "pmd statusline" .claude/settings.json)
assert_eq "$SL_COUNT" "1" "statusLine count after re-run (idempotent)"

# renders inside a PipeMD project
OUT=$($PMD statusline --plain </dev/null 2>&1)
assert_contains "$OUT" "PipeMD" "statusline render"

# the daemon snapshot is the single source — it wins over the live ledger
NOW_MS=$(node -e 'console.log(Date.now())')
printf '{"sessions":[],"conflicts":[{"path":"src/contested.ts","sessionIds":["a","b"]}],"sessionCount":7,"passiveAgents":["Claude Code (pid 1)","OpenCode (pid 2)","Gemini (pid 3)"],"uncommittedFiles":[],"harnessCount":3,"ts":'"$NOW_MS"'}' > .pipemd/.crew-status.json
OUT=$($PMD statusline --plain </dev/null 2>&1)
assert_contains "$OUT" "7 crew" "statusline uses snapshot sessionCount"
assert_contains "$OUT" "3 passive" "statusline uses snapshot passiveAgents"
assert_contains "$OUT" "contested.ts" "statusline uses snapshot conflicts"

# a stale snapshot is ignored — falls back to the live session ledger
printf '{"sessions":[],"conflicts":[],"sessionCount":99,"passiveAgents":[],"uncommittedFiles":[],"harnessCount":0,"ts":1}' > .pipemd/.crew-status.json
OUT=$($PMD statusline --plain </dev/null 2>&1)
assert_not_contains "$OUT" "99 crew" "statusline ignores stale snapshot"
assert_not_contains "$OUT" "passive" "statusline omits passive on daemon-down fallback"
rm -f .pipemd/.crew-status.json

# silent outside a PipeMD project
NOPMD="$(mktemp -d)"
OUT=$(cd "$NOPMD" && $PMD statusline --plain </dev/null 2>&1)
assert_eq "$OUT" "" "statusline empty outside PipeMD project"
rm -rf "$NOPMD"

# inject records stats for the statusline
$PMD inject --trigger on-idle >/dev/null 2>&1
assert_file ".pipemd/.inject-stats.json"

# a user-defined statusline is never clobbered
CUSTOM="$(mktemp -d)"
mkdir -p "$CUSTOM/.pipemd" "$CUSTOM/.claude"
printf 'version: "1.0"\ncommands: {}\npipes: []\ninjected: []\nsettings: {debounceMs: 3000, reServeDelayMs: 2000}\n' > "$CUSTOM/.pipemd/config.yml"
printf '{"statusLine":{"type":"command","command":"my-custom-line"}}\n' > "$CUSTOM/.claude/settings.json"
(cd "$CUSTOM" && $PMD crew install-hooks --harness "Claude Code" >/dev/null 2>&1)
assert_contains "$(cat "$CUSTOM/.claude/settings.json")" "my-custom-line" "custom statusline preserved"
assert_not_contains "$(cat "$CUSTOM/.claude/settings.json")" "pmd statusline" "custom statusline not clobbered"
rm -rf "$CUSTOM"

# ── opencode plugin installer ──
echo -e "${YELLOW}Test: install-hooks (OpenCode)${NC}"
$PMD crew install-hooks --harness "OpenCode" >/dev/null 2>&1
assert_file ".opencode/plugin/pmd-crew.js"
OP_PLUGIN=$(cat .opencode/plugin/pmd-crew.js)
assert_contains "$OP_PLUGIN" "tool.execute.after" "opencode plugin"
assert_contains "$OP_PLUGIN" "tool.execute.before" "opencode plugin"
assert_contains "$OP_PLUGIN" "session.idle" "opencode plugin"
assert_contains "$OP_PLUGIN" "experimental.chat.system.transform" "opencode system.transform hook"
assert_contains "$OP_PLUGIN" '"event"' "opencode event handler"
assert_contains "$OP_PLUGIN" "tui-stats.json" "server plugin stats tracking"
assert_contains "$OP_PLUGIN" "export default" "server plugin default export"
assert_contains "$OP_PLUGIN" "server: async" "server plugin server() export"
assert_contains "$OP_PLUGIN" "handleSessionSwitch" "opencode sub-agent session detection"
assert_contains "$OP_PLUGIN" "getActiveCrewSession" "opencode active crew session resolver"
assert_contains "$OP_PLUGIN" "workerSessions" "opencode worker session tracking"
assert_contains "$OP_PLUGIN" "leaveWorker" "opencode worker cleanup"
assert_contains "$OP_PLUGIN" "session.status" "opencode session.status event handling"
assert_contains "$OP_PLUGIN" "@pmd-plugin-version 101" "opencode plugin version derived from pkg"

# ── opencode TUI plugin installer ──
echo -e "${YELLOW}Test: install-hooks (OpenCode TUI)${NC}"
assert_file ".opencode/pmd-crew-tui.js"
assert_file_contains ".opencode/pmd-crew-tui.js" "sidebar_content" "tui plugin slot"
assert_file_contains ".opencode/pmd-crew-tui.js" "createElement" "tui programmatic elements"
assert_file_contains ".opencode/pmd-crew-tui.js" "pmd-crew-tui" "tui plugin id"
assert_file_contains ".opencode/pmd-crew-tui.js" "order: 250" "tui plugin order"

# ── TUI plugin must NOT live under plugin/ ──
# That directory is glob-scanned by OpenCode's server plugin auto-discovery;
# a TUI file there fails to load (no @opentui/solid resolver in that context).
echo -e "${YELLOW}Test: TUI plugin excluded from server auto-discovery${NC}"
assert_not_contains "$(ls .opencode/plugin/ 2>/dev/null || echo '')" "pmd-crew-tui" "tui plugin not in plugin/"

# ── TUI plugin parses as valid JS ──
echo -e "${YELLOW}Test: TUI plugin syntax${NC}"
if node --check .opencode/pmd-crew-tui.js 2>/dev/null; then
  echo -e "  ${GREEN}✓${NC} tui plugin parses as valid JS"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} tui plugin has syntax errors"
  FAIL=$((FAIL + 1))
fi

# ── opencode tui.json registration ──
echo -e "${YELLOW}Test: opencode tui.json registration${NC}"
assert_file ".opencode/tui.json"
TUI_JSON=$(cat .opencode/tui.json)
assert_contains "$TUI_JSON" '"./pmd-crew-tui.js"' "tui.json plugin entry"
assert_not_contains "$TUI_JSON" "plugin/pmd-crew-tui.js" "tui.json has no legacy plugin/ path"

# ── idempotent install ──
$PMD crew install-hooks --harness "OpenCode" >/dev/null 2>&1
BEFORE=$(wc -c < .opencode/plugin/pmd-crew.js)
$PMD crew install-hooks --harness "OpenCode" >/dev/null 2>&1
AFTER=$(wc -c < .opencode/plugin/pmd-crew.js)
assert_eq "$BEFORE" "$AFTER" "idempotent: server plugin size unchanged"

# ── crew status --json ──
echo -e "${YELLOW}Test: crew status --json${NC}"
JSON_OUT=$($PMD crew status --json 2>&1)
assert_contains "$JSON_OUT" '"sessionCount"' "json output has sessionCount"
assert_contains "$JSON_OUT" '"conflicts"' "json output has conflicts"
assert_contains "$JSON_OUT" '"sessions"' "json output has sessions"
assert_contains "$JSON_OUT" '"harnessCount"' "json output has harnessCount"
assert_contains "$JSON_OUT" '"passiveAgents"' "json output has passiveAgents"
assert_contains "$JSON_OUT" '"uncommittedFiles"' "json output has uncommittedFiles"

# ── gemini hook installer ──
echo -e "${YELLOW}Test: install-hooks (Gemini)${NC}"
$PMD crew install-hooks --harness "Gemini" >/dev/null 2>&1
assert_file ".gemini/settings.json"
GSET=$(cat .gemini/settings.json)
assert_contains "$GSET" "AfterTool" "gemini settings"
assert_contains "$GSET" "BeforeTool" "gemini settings"
assert_contains "$GSET" "pmd crew claim" "gemini settings"
# Golden Rule: the hook must end by emitting a bare JSON object to stdout.
assert_contains "$GSET" "echo '{}'" "gemini hook stdout"
$PMD crew install-hooks --harness "Gemini" >/dev/null 2>&1
GCOUNT=$(grep -c "pmd crew claim" .gemini/settings.json)
assert_eq "$GCOUNT" "1" "gemini hook count after re-run (idempotent)"

# ── gemini dev-side status surface (systemMessage hook) ──
echo -e "${YELLOW}Test: statusline (Gemini surface)${NC}"
GSET2=$(cat .gemini/settings.json)
assert_contains "$GSET2" "SessionStart" "gemini SessionStart statusline hook"
assert_contains "$GSET2" "AfterAgent" "gemini AfterAgent statusline hook"
assert_contains "$GSET2" "pmd statusline --format gemini" "gemini statusline hook command"
GSL_COUNT=$(grep -c "pmd statusline" .gemini/settings.json)
assert_eq "$GSL_COUNT" "2" "gemini statusline hook count after re-run (idempotent)"
# --format gemini emits a JSON systemMessage object — the field Gemini renders to the dev.
rm -f .pipemd/.statusline-gemini.json
GOUT=$($PMD statusline --format gemini </dev/null 2>&1)
assert_contains "$GOUT" '"systemMessage"' "gemini statusline emits systemMessage JSON"
assert_contains "$GOUT" "PipeMD" "gemini statusline payload carries status"
# Gemini double-fires SessionStart — a rapid identical re-fire is debounced.
GOUT2=$($PMD statusline --format gemini </dev/null 2>&1)
assert_eq "$GOUT2" "" "gemini statusline debounces identical rapid re-fire"

# ── hooks must not break edits outside a PipeMD project ──
echo -e "${YELLOW}Test: claim outside PipeMD project exits 0${NC}"
OUTSIDE="$(mktemp -d)"
( cd "$OUTSIDE" && $PMD crew claim foo.ts >/dev/null 2>&1 )
assert_eq "$?" "0" "exit code outside project"
rm -rf "$OUTSIDE"

# ── hook removal ──
echo -e "${YELLOW}Test: remove-hooks (Claude Code)${NC}"
$PMD crew install-hooks --harness "Claude Code" >/dev/null 2>&1
$PMD crew install-hooks --harness "Gemini" >/dev/null 2>&1
$PMD crew install-hooks --harness "OpenCode" >/dev/null 2>&1
$PMD uninstall --force >/dev/null 2>&1 || true
assert_not_contains "$(cat .claude/settings.json 2>/dev/null || echo '{}')" "pmd crew" "claude hooks after uninstall"
assert_not_contains "$(cat .claude/settings.json 2>/dev/null || echo '{}')" "pmd statusline" "claude statusline after uninstall"
assert_not_contains "$(cat .gemini/settings.json 2>/dev/null || echo '{}')" "pmd crew" "gemini hooks after uninstall"
assert_not_contains "$(cat .gemini/settings.json 2>/dev/null || echo '{}')" "pmd statusline" "gemini statusline after uninstall"
assert_not_contains "$(ls .opencode/plugin/ 2>/dev/null || echo '')" "pmd-crew" "opencode plugins after uninstall"
assert_not_contains "$(ls .opencode/ 2>/dev/null || echo '')" "pmd-crew-tui" "opencode tui plugin after uninstall"

# ── crew.sh delegator ──
echo -e "${YELLOW}Test: crew.sh delegator script${NC}"
mkdir -p .pipemd/scripts/crew .pipemd/scripts/lib
cp "$ROOT_DIR/scripts/Shared/crew/crew.sh" .pipemd/scripts/crew/crew.sh
cp "$ROOT_DIR/scripts/Shared/lib/limit.sh" .pipemd/scripts/lib/limit.sh
OUT=$(PATH="$PATH" bash .pipemd/scripts/crew/crew.sh 2>&1)
# crew.sh calls bare `pmd`; without it on PATH it prints a graceful notice.
if echo "$OUT" | grep -q "pmd not on PATH"; then
  echo -e "  ${GREEN}✓${NC} crew.sh degrades gracefully when pmd is absent"
  PASS=$((PASS + 1))
else
  assert_contains "$OUT" "Crew" "crew.sh output"
fi

echo ""
echo -e "${YELLOW}═══ Results ═══${NC}"
echo -e "  ${GREEN}Pass: $PASS${NC}  ${RED}Fail: $FAIL${NC}"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
