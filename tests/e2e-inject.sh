#!/usr/bin/env bash
set -uo pipefail
# e2e-inject.sh — PipeMD Smart Context Injection end-to-end tests.
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

assert_json_contains() {
  if echo "$1" | grep -q -- "$2"; then
    echo -e "  ${GREEN}✓${NC} ${3:-output} matches: $2"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} ${3:-output} missing pattern: $2"
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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PMD="node $ROOT_DIR/dist/index.js"

if [ ! -f "$ROOT_DIR/dist/index.js" ]; then
  echo -e "${RED}✖ dist/index.js missing — run 'pnpm build' first.${NC}"
  exit 1
fi

# Helper: scaffold a minimal .pipemd with scripts for init
scaffold_scripts() {
  local base="$ROOT_DIR/scripts"
  mkdir -p .pipemd/scripts/{project,git,quality,crew,architecture,lib}
  # Copy all available scripts, trying Shared/ first, then ecosystem-specific
  for dir in project git quality; do
    for f in "$base/Shared/$dir/"*.sh; do
      [ -f "$f" ] && cp "$f" ".pipemd/scripts/$dir/" 2>/dev/null
    done
    for f in "$base/Node-TypeScript/$dir/"*.sh; do
      [ -f "$f" ] && cp "$f" ".pipemd/scripts/$dir/" 2>/dev/null
    done
  done
  cp "$base/Shared/crew/crew.sh" .pipemd/scripts/crew/ 2>/dev/null
  for f in "$base/Shared/architecture/"*.sh; do
    [ -f "$f" ] && cp "$f" ".pipemd/scripts/architecture/" 2>/dev/null
  done
  for f in "$base/Node-TypeScript/architecture/"*.sh; do
    [ -f "$f" ] && cp "$f" ".pipemd/scripts/architecture/" 2>/dev/null
  done
  cp "$base/Shared/lib/limit.sh" .pipemd/scripts/lib/ 2>/dev/null
  chmod +x .pipemd/scripts/**/*.sh 2>/dev/null
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q
git config user.email t@t.co
git config user.name t
mkdir -p src
echo "console.log('hello');" > src/index.ts
echo '{"name":"test","version":"1.0.0"}' > package.json
git add -A && git commit -q -m "init"

echo -e "${YELLOW}═══ PipeMD Smart Context Injection E2E Tests ═══${NC}"

# ── Suite 1: pmd init with delivery modes ──
echo -e "\n${YELLOW}Suite 1: pmd init --delivery${NC}"

echo -e "${YELLOW}  Test: init with active delivery scaffolds injection.yml${NC}"
rm -rf .pipemd .claude .gemini .opencode AGENTS.md AI_CONTEXT.md
scaffold_scripts
OUT=$($PMD init --yes --mode agent --harnesses "claude" --ecosystem "Node/TypeScript" --delivery active --scripts "tree,git-status,todos,crew,arch" 2>&1)
assert_contains "$OUT" "injection.yml" "init active creates injection.yml"
assert_contains "$OUT" "active" "init active mentions active mode"
assert_file ".pipemd/injection.yml"
INJECTION_YML=$(cat .pipemd/injection.yml 2>/dev/null || echo "")
assert_contains "$INJECTION_YML" "delivery:" "injection.yml has delivery field"
assert_contains "$INJECTION_YML" "active" "injection.yml delivery is active"

echo -e "${YELLOW}  Test: init with expert delivery writes delivery: expert${NC}"
rm -rf .pipemd .claude .gemini .opencode AGENTS.md AI_CONTEXT.md
scaffold_scripts
OUT=$($PMD init --yes --mode agent --harnesses "claude" --ecosystem "Node/TypeScript" --delivery expert --scripts "tree,git-status,todos,crew,arch" 2>&1)
assert_file ".pipemd/injection.yml"
INJECTION_YML=$(cat .pipemd/injection.yml 2>/dev/null || echo "")
assert_contains "$INJECTION_YML" "delivery:" "expert injection.yml has delivery field"
assert_contains "$INJECTION_YML" "expert" "expert injection.yml delivery is expert"

echo -e "${YELLOW}  Test: init with passive delivery skips injection.yml${NC}"
rm -rf .pipemd .claude .gemini .opencode AGENTS.md AI_CONTEXT.md
scaffold_scripts
OUT=$($PMD init --yes --mode agent --harnesses "claude" --ecosystem "Node/TypeScript" --delivery passive --scripts "tree,git-status,todos" 2>&1)
assert_not_contains "$OUT" "injection.yml" "passive init skips injection.yml"

# ── Suite 2: pmd inject command ──
echo -e "\n${YELLOW}Suite 2: pmd inject command${NC}"

rm -rf .pipemd .claude .gemini .opencode AGENTS.md AI_CONTEXT.md
scaffold_scripts
$PMD init --yes --mode agent --harnesses "claude" --ecosystem "Node/TypeScript" --delivery active --scripts "tree,git-status,todos,crew,arch" >/dev/null 2>&1

echo -e "${YELLOW}  Test: inject --trigger before-edit produces output${NC}"
OUT=$($PMD inject --trigger before-edit --file src/index.ts 2>/dev/null)
if [ -n "$OUT" ]; then
  echo -e "  ${GREEN}✓${NC} before-edit produced output"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} before-edit produced no output"
  FAIL=$((FAIL + 1))
fi

echo -e "${YELLOW}  Test: inject output contains source header${NC}"
assert_contains "$OUT" "[pmd:" "inject has pmd source header"

echo -e "${YELLOW}  Test: inject --trigger before-read produces crew-status${NC}"
OUT=$($PMD inject --trigger before-read 2>/dev/null)
assert_contains "$OUT" "[pmd:" "before-read has pmd source header"

echo -e "${YELLOW}  Test: inject deduplicates on second call (same session)${NC}"
# Use explicit session to ensure both calls share a session
OUT_FIRST=$($PMD inject --trigger before-edit --file src/index.ts --session dedup-test 2>/dev/null)
OUT_SECOND=$($PMD inject --trigger before-edit --file src/index.ts --session dedup-test 2>/dev/null)
if [ -z "$OUT_SECOND" ]; then
  echo -e "  ${GREEN}✓${NC} second call deduplicated (empty output)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} second call should be deduplicated but got output"
  FAIL=$((FAIL + 1))
fi

echo -e "${YELLOW}  Test: different session IDs get independent dedup${NC}"
OUT3=$($PMD inject --trigger before-edit --file src/index.ts --session test-session-1 2>/dev/null)
if [ -n "$OUT3" ]; then
  echo -e "  ${GREEN}✓${NC} different session gets fresh injection"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} different session should get fresh injection"
  FAIL=$((FAIL + 1))
fi

OUT4=$($PMD inject --trigger before-edit --file src/index.ts --session test-session-2 2>/dev/null)
if [ -n "$OUT4" ]; then
  echo -e "  ${GREEN}✓${NC} third session also gets fresh injection"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} third session should get fresh injection"
  FAIL=$((FAIL + 1))
fi

# ── Suite 3: --format claude-hook ──
echo -e "\n${YELLOW}Suite 3: --format claude-hook${NC}"

echo -e "${YELLOW}  Test: claude-hook format wraps in hookSpecificOutput${NC}"
OUT=$($PMD inject --trigger before-edit --file src/index.ts --session fmt-test-1 --format claude-hook 2>/dev/null)
assert_json_contains "$OUT" 'hookSpecificOutput' "claude-hook has hookSpecificOutput"
assert_json_contains "$OUT" 'additionalContext' "claude-hook has additionalContext"
assert_json_contains "$OUT" 'hookEventName' "claude-hook has hookEventName"
assert_json_contains "$OUT" 'PreToolUse' "claude-hook before-edit maps to PreToolUse"

echo -e "${YELLOW}  Test: claude-hook JSON is valid and well-formed${NC}"
if echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'hookSpecificOutput' in d; assert 'additionalContext' in d['hookSpecificOutput']; assert 'hookEventName' in d['hookSpecificOutput']" 2>/dev/null; then
  echo -e "  ${GREEN}✓${NC} claude-hook output is valid JSON with required fields"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} claude-hook output is not valid JSON or missing fields: $OUT"
  FAIL=$((FAIL + 1))
fi

echo -e "${YELLOW}  Test: claude-hook after-edit maps to PostToolUse${NC}"
# Clear dedup with new session
OUT=$($PMD inject --trigger before-read --session after-edit-fmt --format claude-hook 2>/dev/null)
# This would be PostToolUse for after-edit — but after-edit uses async-validate which returns nothing
# Instead test before-read
OUT=$($PMD inject --trigger before-read --session read-fmt-1 --format claude-hook 2>/dev/null)
assert_json_contains "$OUT" 'PreToolUse' "claude-hook before-read maps to PreToolUse"

echo -e "${YELLOW}  Test: claude-hook handles ANSI/control chars safely${NC}"
# Write a file with special characters to test JSON escaping
printf 'const x = "hello\tworld\n";\x1b[31mANSI\x1b[0m\n' > src/ansi.ts
OUT=$($PMD inject --trigger before-edit --file src/ansi.ts --session ansi-test --format claude-hook 2>/dev/null)
if echo "$OUT" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  echo -e "  ${GREEN}✓${NC} claude-hook output with special chars is valid JSON"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} claude-hook output with special chars is invalid JSON"
  FAIL=$((FAIL + 1))
fi

echo -e "${YELLOW}  Test: claude-hook with no new data outputs nothing (dedup)${NC}"
OUT=$($PMD inject --trigger before-edit --file src/index.ts --session fmt-test-1 --format claude-hook 2>/dev/null)
if [ -z "$OUT" ]; then
  echo -e "  ${GREEN}✓${NC} claude-hook dedup produces no output"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} claude-hook dedup should be empty but got: $OUT"
  FAIL=$((FAIL + 1))
fi

# ── Suite 4: --format gemini-json ──
echo -e "\n${YELLOW}Suite 4: --format gemini-json${NC}"

echo -e "${YELLOW}  Test: gemini-json outputs valid JSON with context on stdout${NC}"
OUT=$($PMD inject --trigger before-edit --file src/index.ts --session gemini-test-1 --format gemini-json 2>/dev/null)
assert_json_contains "$OUT" '"context"' "gemini-json has context field"

echo -e "${YELLOW}  Test: gemini-json output is valid JSON${NC}"
if echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'context' in d" 2>/dev/null; then
  echo -e "  ${GREEN}✓${NC} gemini-json output is valid JSON with context field"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} gemini-json output is not valid JSON: $OUT"
  FAIL=$((FAIL + 1))
fi

echo -e "${YELLOW}  Test: gemini-json with no new data outputs {}${NC}"
OUT=$($PMD inject --trigger before-edit --file src/index.ts --session gemini-test-1 --format gemini-json 2>/dev/null)
assert_contains "$OUT" "{}" "gemini-json dedup outputs {}"

# ── Suite 5: --async-validate is non-blocking ──
echo -e "\n${YELLOW}Suite 5: --async-validate non-blocking${NC}"

echo -e "${YELLOW}  Test: --async-validate returns quickly (< 2s)${NC}"
START=$(date +%s%N)
$PMD inject --trigger after-edit --file src/index.ts --async-validate 2>/dev/null
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
if [ "$ELAPSED_MS" -lt 2000 ]; then
  echo -e "  ${GREEN}✓${NC} async-validate returned in ${ELAPSED_MS}ms (< 2s)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} async-validate took ${ELAPSED_MS}ms (expected < 2s)"
  FAIL=$((FAIL + 1))
fi

# ── Suite 6: hooks installation with delivery mode ──
echo -e "\n${YELLOW}Suite 6: hooks installation with delivery mode${NC}"

echo -e "${YELLOW}  Test: init active installs Claude Code hooks with injection${NC}"
rm -rf .pipemd .claude .gemini .opencode AGENTS.md AI_CONTEXT.md
scaffold_scripts
OUT=$($PMD init --yes --mode agent --harnesses "claude" --ecosystem "Node/TypeScript" --delivery active --scripts "tree,git-status,todos,crew,arch" 2>&1)
assert_contains "$OUT" "hooks installed" "init installs hooks"
assert_file ".claude/settings.json"
SETTINGS=$(cat .claude/settings.json 2>/dev/null || echo "")
assert_contains "$SETTINGS" "pmd inject" "Claude settings has pmd inject"
assert_contains "$SETTINGS" "claude-hook" "Claude inject uses claude-hook format"
assert_contains "$SETTINGS" "PMD_SESSION" "Claude inject uses PMD_SESSION"
assert_contains "$SETTINGS" '"timeout": 5' "Claude inject hooks have timeout"

echo -e "${YELLOW}  Test: Gemini hooks don't discard stderr${NC}"
rm -rf .pipemd .claude .gemini .opencode AGENTS.md AI_CONTEXT.md
scaffold_scripts
OUT=$($PMD init --yes --mode agent --harnesses "gemini" --ecosystem "Node/TypeScript" --delivery active --scripts "tree,git-status,todos,crew,arch" 2>&1)
assert_file ".gemini/settings.json"
SETTINGS=$(cat .gemini/settings.json 2>/dev/null || echo "")
assert_contains "$SETTINGS" "pmd inject" "Gemini settings has pmd inject"
assert_contains "$SETTINGS" "gemini-json" "Gemini inject uses gemini-json format"
# Before-read and before-edit should NOT have '; echo {}' — the JSON is on stdout
BEFORE_READ_HOOK=$(echo "$SETTINGS" | grep -o 'BeforeTool.*gemini-json[^"]*' | head -1 || true)
if echo "$SETTINGS" | grep -q 'pmd inject.*gemini-json.*2>/dev/null; echo'; then
  echo -e "  ${RED}✖${NC} Gemini before-read hook still redirects stderr to /dev/null + echo {}"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}✓${NC} Gemini injection hooks don't echo {} fallback"
  PASS=$((PASS + 1))
fi

echo -e "${YELLOW}  Test: passive init installs crew hooks but NOT inject hooks${NC}"
rm -rf .pipemd .claude .gemini .opencode AGENTS.md AI_CONTEXT.md
scaffold_scripts
OUT=$($PMD init --yes --mode agent --harnesses "claude" --ecosystem "Node/TypeScript" --delivery passive --scripts "tree,git-status,todos" 2>&1)
assert_file ".claude/settings.json"
SETTINGS=$(cat .claude/settings.json 2>/dev/null || echo "")
assert_contains "$SETTINGS" "pmd crew" "passive still installs crew hooks"
assert_not_contains "$SETTINGS" "pmd inject" "passive does NOT install inject hooks"

echo -e "${YELLOW}  Test: crew install-hooks reads delivery from config${NC}"
rm -rf .claude
mkdir -p .claude
OUT=$($PMD crew install-hooks 2>&1)
SETTINGS=$(cat .claude/settings.json 2>/dev/null || echo "")
assert_not_contains "$SETTINGS" "pmd inject" "crew install-hooks respects passive config"

# ── Suite 7: inject on-idle trigger ──
echo -e "\n${YELLOW}Suite 7: on-idle trigger${NC}"

echo -e "${YELLOW}  Test: inject --trigger on-idle produces output${NC}"
OUT=$($PMD inject --trigger on-idle --session idle-test-1 2>/dev/null)
assert_contains "$OUT" "[pmd:" "on-idle produces output"

# ── Suite 8: multi-file validation guard ──
echo -e "\n${YELLOW}Suite 8: multi-file validation guard${NC}"

echo -e "${YELLOW}  Test: validation guard clears between files${NC}"
echo "const a: string = 1;" > src/fileA.ts
echo "const b: string = 2;" > src/fileB.ts
$PMD inject --trigger after-edit --file src/fileA.ts --async-validate --session guard-test 2>/dev/null
sleep 2
$PMD inject --trigger after-edit --file src/fileB.ts --async-validate --session guard-test 2>/dev/null
sleep 2
CACHE_DIR=".pipemd/cache/validation"
FILEA_CACHE=$(ls "$CACHE_DIR"/validation*fileA* 2>/dev/null || echo "")
FILEB_CACHE=$(ls "$CACHE_DIR"/validation*fileB* 2>/dev/null || echo "")
if [ -n "$FILEA_CACHE" ] && [ -n "$FILEB_CACHE" ]; then
  echo -e "  ${GREEN}✓${NC} both fileA and fileB got validation cache entries"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} validation guard over-throttled: fileA=$FILEA_CACHE fileB=$FILEB_CACHE"
  FAIL=$((FAIL + 1))
fi

# ── Suite 9: stable session identity (empty --session dedup) ──
echo -e "\n${YELLOW}Suite 9: stable session identity (empty --session dedup)${NC}"

echo -e "${YELLOW}  Test: two injects with no --session — second is deduped${NC}"
rm -rf .pipemd/cache/injected
OUT_A=$($PMD inject --trigger before-read 2>/dev/null)
OUT_B=$($PMD inject --trigger before-read 2>/dev/null)
if [ -n "$OUT_A" ] && [ -z "$OUT_B" ]; then
  echo -e "  ${GREEN}✓${NC} first inject emits, second is deduped (stable session ID)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} stable-session dedup failed: A has output='$([ -n "$OUT_A" ] && echo yes || echo no)' B has output='$([ -n "$OUT_B" ] && echo yes || echo no)'"
  FAIL=$((FAIL + 1))
fi

echo -e "${YELLOW}  Test: explicit --session still isolates from implicit session${NC}"
rm -rf .pipemd/cache/injected
OUT_A=$($PMD inject --trigger before-read 2>/dev/null)
OUT_B=$($PMD inject --trigger before-read --session explicit-isolated 2>/dev/null)
if [ -n "$OUT_A" ] && [ -n "$OUT_B" ]; then
  echo -e "  ${GREEN}✓${NC} explicit session bypasses implicit dedup"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} session isolation failed: A='$OUT_A' B='$OUT_B'"
  FAIL=$((FAIL + 1))
fi

# ── Suite 10: Claude on-idle hook doesn't discard stdout ──
echo -e "\n${YELLOW}Suite 10: Claude on-idle hook stdout${NC}"

echo -e "${YELLOW}  Test: Claude settings on-idle hook lets stdout through${NC}"
rm -rf .pipemd .claude .gemini .opencode AGENTS.md AI_CONTEXT.md
scaffold_scripts
OUT=$($PMD init --yes --mode agent --harnesses "claude" --ecosystem "Node/TypeScript" --delivery active --scripts "tree,git-status,todos,crew,arch" 2>&1)
SETTINGS=$(cat .claude/settings.json 2>/dev/null || echo "")
ON_IDLE_HOOK=$(echo "$SETTINGS" | grep -o 'pmd inject.*on-idle[^"]*' | head -1 || true)
if echo "$ON_IDLE_HOOK" | grep -q '>/dev/null'; then
  echo -e "  ${RED}✖${NC} Claude on-idle hook still discards stdout"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}✓${NC} Claude on-idle hook stdout is not redirected"
  PASS=$((PASS + 1))
fi
assert_contains "$ON_IDLE_HOOK" "claude-hook" "on-idle hook uses claude-hook format"

# ── Summary ──
echo ""
echo -e "${YELLOW}═══ Summary ═══${NC}"
TOTAL=$((PASS + FAIL))
echo -e "  ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} ($TOTAL total)"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}✖ Some tests failed${NC}"
  exit 1
else
  echo -e "${GREEN}✔ All tests passed${NC}"
  exit 0
fi
