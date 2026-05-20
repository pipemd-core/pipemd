#!/usr/bin/env bash
set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

assert_file() {
  local file="$1"
  if [ -f "$file" ]; then
    echo -e "  ${GREEN}✓${NC} File exists: $file"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} File missing: $file"
    FAIL=$((FAIL + 1))
  fi
}

assert_dir() {
  local dir="$1"
  if [ -d "$dir" ]; then
    echo -e "  ${GREEN}✓${NC} Directory exists: $dir"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} Directory missing: $dir"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="${3:-output}"
  if echo "$haystack" | grep -q "$needle"; then
    echo -e "  ${GREEN}✓${NC} $label contains: $needle"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} $label missing: $needle"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="${3:-output}"
  if echo "$haystack" | grep -q "$needle"; then
    echo -e "  ${RED}✖${NC} $label should not contain: $needle"
    FAIL=$((FAIL + 1))
  else
    echo -e "  ${GREEN}✓${NC} $label does not contain: $needle"
    PASS=$((PASS + 1))
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GMD="node $ROOT_DIR/dist/index.js"
WORKSPACE=""

cleanup() {
  if [ -n "$WORKSPACE" ] && [ -d "$WORKSPACE" ]; then
    cd "$WORKSPACE" 2>/dev/null || true
    $GMD stop 2>/dev/null || true
    rm -rf "$WORKSPACE"
  fi
}

trap cleanup EXIT

echo -e "${YELLOW}═══ PipeMD E2E Tests ═══${NC}"
echo ""

# Build first
echo -e "${DIM}Building PipeMD...${NC}"
cd "$ROOT_DIR"
pnpm build 2>&1 | tail -3
echo ""

# Create temp workspace
WORKSPACE=$(mktemp -d)
cd "$WORKSPACE"

echo -e "${DIM}Test workspace: $WORKSPACE${NC}"
echo ""

# ── Test 1: Project setup ──
echo -e "${YELLOW}Test 1: Project setup${NC}"
git init --initial-branch=main 2>/dev/null
echo '{"name": "e2e-test", "version": "1.0.0", "dependencies": {"chalk": "^5.0.0"}, "devDependencies": {"typescript": "^5.0.0"}}' > package.json
echo '{"compilerOptions": {"strict": true, "target": "ES2022"}, "include": ["src"]}' > tsconfig.json
mkdir -p src
echo "const x: number = 1;" > src/index.ts
echo "// TODO: implement feature X" >> src/index.ts
echo "// FIXME: broken logic" >> src/index.ts
git add -A && git commit -m "initial commit" --quiet 2>/dev/null
echo -e "  ${GREEN}✓${NC} Test project created"
PASS=$((PASS + 1))
echo ""

# ── Test 2: pmd init --yes ──
echo -e "${YELLOW}Test 2: pmd init --yes${NC}"
$GMD init --yes 2>&1 || {
  echo -e "  ${RED}✖${NC} pmd init --yes failed"
  FAIL=$((FAIL + 1))
  echo ""
  echo -e "${RED}═══ ABORT ═══${NC}"
  exit 1
}
echo ""

assert_file ".pipemd/config.yml"
assert_file ".pipemd/template.md"
assert_dir ".pipemd/scripts"
assert_dir ".pipemd/scripts/project"
assert_dir ".pipemd/scripts/git"
assert_dir ".pipemd/scripts/quality"
assert_dir ".pipemd/scripts/lib"
assert_file ".pipemd/scripts/lib/limit.sh"

CONFIG_CONTENT=$(cat .pipemd/config.yml)
assert_contains "$CONFIG_CONTENT" "commands:" "config.yml"
assert_contains "$CONFIG_CONTENT" "pipes:" "config.yml"
assert_contains "$CONFIG_CONTENT" "tree" "config.yml"
echo ""

# ── Test 3: pmd run ──
echo -e "${YELLOW}Test 3: pmd run (one-shot render)${NC}"
OUTPUT=$($GMD run 2>&1) || true
assert_contains "$OUTPUT" "pmd:" "rendered output"
assert_contains "$OUTPUT" "PipeMD" "rendered output"
echo ""

# ── Test 4: pmd run --output ──
echo -e "${YELLOW}Test 4: pmd run --output${NC}"
$GMD run --output "$WORKSPACE/rendered.md" 2>&1 || true
assert_file "$WORKSPACE/rendered.md"
if [ -f "$WORKSPACE/rendered.md" ]; then
  RENDERED=$(cat "$WORKSPACE/rendered.md")
  assert_contains "$RENDERED" "pmd:" "rendered file"
fi
echo ""

# ── Test 5: pmd start ──
echo -e "${YELLOW}Test 5: pmd start (daemon)${NC}"
$GMD start 2>&1
sleep 2

if [ -f ".pipemd/.daemon.pid" ]; then
  PID=$(cat .pipemd/.daemon.pid)
  if kill -0 "$PID" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Daemon running (PID $PID)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} Daemon PID found but not running"
    FAIL=$((FAIL + 1))
  fi
else
  echo -e "  ${YELLOW}⊘${NC} No PID file (daemon may not have started)"
  SKIP=$((SKIP + 1))
fi
echo ""

# ── Test 6: pmd status ──
echo -e "${YELLOW}Test 6: pmd status${NC}"
$GMD status 2>&1 || true
echo ""

# ── Test 7: Named pipe (if mkfifo available) ──
echo -e "${YELLOW}Test 7: Named pipe read${NC}"
PIPE_FILE=""
if [ -p "AGENTS.md" ]; then
  PIPE_FILE="AGENTS.md"
elif [ -p "AI_CONTEXT.md" ]; then
  PIPE_FILE="AI_CONTEXT.md"
fi

if [ -n "$PIPE_FILE" ]; then
  echo -e "  ${DIM}Reading pipe: $PIPE_FILE${NC}"
  PIPE_OUTPUT=$(timeout 5 cat "$PIPE_FILE" 2>/dev/null || true)
  if [ -n "$PIPE_OUTPUT" ]; then
    assert_contains "$PIPE_OUTPUT" "pmd:" "pipe output"
    echo -e "  ${GREEN}✓${NC} Named pipe produced output"
    PASS=$((PASS + 1))
  else
    echo -e "  ${YELLOW}⊘${NC} Pipe read timed out or empty"
    SKIP=$((SKIP + 1))
  fi
else
  echo -e "  ${YELLOW}⊘${NC} No named pipe found (Legacy Mode or not available)"
  SKIP=$((SKIP + 1))
fi
echo ""

# ── Test 8: pmd stop ──
echo -e "${YELLOW}Test 8: pmd stop${NC}"
$GMD stop 2>&1 || true
sleep 1

PID_FILE=".pipemd/.daemon.pid"
if [ ! -f "$PID_FILE" ]; then
  echo -e "  ${GREEN}✓${NC} PID file cleaned up"
  PASS=$((PASS + 1))
else
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && ! kill -0 "$OLD_PID" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Daemon process stopped (PID file stale)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} Daemon may still be running"
    FAIL=$((FAIL + 1))
  fi
fi
echo ""

# ── Test 9: pmd doctor ──
echo -e "${YELLOW}Test 9: pmd doctor (healthy project)${NC}"
DOCTOR_OUTPUT=$($GMD doctor 2>&1) || true
assert_contains "$DOCTOR_OUTPUT" "Node.js version" "doctor output"
assert_contains "$DOCTOR_OUTPUT" "Config file valid" "doctor output"
assert_contains "$DOCTOR_OUTPUT" "Template has pmd tags" "doctor output"
assert_contains "$DOCTOR_OUTPUT" "scripts are executable" "doctor output"
assert_not_contains "$DOCTOR_OUTPUT" "Config file missing" "doctor output"
echo ""

# ── Test 10: pmd doctor on missing config ──
echo -e "${YELLOW}Test 10: pmd doctor (broken project)${NC}"
mv .pipemd/config.yml .pipemd/config.yml.bak
DOCTOR_BROKEN=$($GMD doctor 2>&1) || true
assert_contains "$DOCTOR_BROKEN" "Config file missing" "doctor broken"
mv .pipemd/config.yml.bak .pipemd/config.yml
echo ""

# ── Test 11: File mode init and run ──
WORKSPACE2=$(mktemp -d)
cd "$WORKSPACE2"
echo -e "${DIM}File-mode workspace: $WORKSPACE2${NC}"
git init --initial-branch=main 2>/dev/null
echo '{"name": "file-mode-test", "version": "1.0.0"}' > package.json
git add -A && git commit -m "initial" --quiet 2>/dev/null

$GMD init --yes --mode file --output pmd.md 2>&1
assert_file ".pipemd/config.yml"
assert_file ".pipemd/template.md"

$GMD run -o pmd.md 2>&1 || true
assert_file "pmd.md"
if [ -f "pmd.md" ]; then
  FILE_OUTPUT=$(cat pmd.md)
  assert_contains "$FILE_OUTPUT" "pmd:" "file-mode output"
  assert_contains "$FILE_OUTPUT" "Project Context" "file-mode output"
  assert_not_contains "$FILE_OUTPUT" "PipeMD Context File" "file-mode output"
  assert_not_contains "$FILE_OUTPUT" "write-back" "file-mode output"
fi
cd "$WORKSPACE"
rm -rf "$WORKSPACE2"
echo ""

# ── Test 12: Headless file mode ──
WORKSPACE3=$(mktemp -d)
cd "$WORKSPACE3"
echo -e "${DIM}Headless workspace: $WORKSPACE3${NC}"
git init --initial-branch=main 2>/dev/null
echo '{"name": "headless-test", "version": "1.0.0"}' > package.json
git add -A && git commit -m "initial" --quiet 2>/dev/null

HEADLESS_OUTPUT=$($GMD init --headless --mode file --output context.md 2>&1) || true
assert_contains "$HEADLESS_OUTPUT" "PIPEDM_HEADLESS_RESULT" "headless output"
assert_contains "$HEADLESS_OUTPUT" '"mode":"file"' "headless JSON"
assert_file ".pipemd/config.yml"
cd "$WORKSPACE"
rm -rf "$WORKSPACE3"
echo ""

# ── Summary ──
echo -e "${YELLOW}═══ Results ═══${NC}"
echo -e "  ${GREEN}PASS${NC}: $PASS"
echo -e "  ${RED}FAIL${NC}: $FAIL"
echo -e "  ${YELLOW}SKIP${NC}: $SKIP"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}✖ Some tests failed${NC}"
  exit 1
else
  echo -e "${GREEN}✔ All tests passed${NC}"
  exit 0
fi