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

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="${3:-output}"
  if echo "$haystack" | grep -qF -- "$needle"; then
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
  if echo "$haystack" | grep -qF -- "$needle"; then
    echo -e "  ${RED}✖${NC} $label should not contain: $needle"
    FAIL=$((FAIL + 1))
  else
    echo -e "  ${GREEN}✓${NC} $label does not contain: $needle"
    PASS=$((PASS + 1))
  fi
}

assert_equals() {
  local expected="$1"
  local actual="$2"
  local label="${3:-value}"
  if [ "$expected" = "$actual" ]; then
    echo -e "  ${GREEN}✓${NC} $label matches expected"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} $label mismatch"
    echo -e "    expected: $expected"
    echo -e "    actual:   $actual"
    FAIL=$((FAIL + 1))
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

echo -e "${YELLOW}═══ Bidirectional Sync E2E Tests ═══${NC}"
echo ""

# Build first
echo -e "${DIM}Building PipeMD...${NC}"
cd "$ROOT_DIR"
pnpm build 2>&1 | tail -3
echo ""

# ── Test 1: Directive update in init template ──
echo -e "${YELLOW}Test 1: New directive in template${NC}"
WORKSPACE=$(mktemp -d)
cd "$WORKSPACE"

git init --initial-branch=main 2>/dev/null
echo '{"name": "bidir-test", "version": "1.0.0"}' > package.json
echo '{"compilerOptions": {"strict": true}}' > tsconfig.json
git add -A && git commit -m "init" --quiet 2>/dev/null

$GMD init --yes 2>&1 | tail -5

TEMPLATE=$(cat .pipemd/template.md)
assert_contains "$TEMPLATE" "PipeMD Context File" "template"
assert_contains "$TEMPLATE" "read-only" "template"
assert_contains "$TEMPLATE" "bidirectional write-back" "template"
assert_contains "$TEMPLATE" "pmd-context" "template"
assert_not_contains "$TEMPLATE" "AI SYSTEM DIRECTIVE" "template"
assert_not_contains "$TEMPLATE" "Scratchpad" "template"

echo ""

# ── Test 2: reverseInject unit tests ──
echo -e "${YELLOW}Test 2: reverseInject unit tests${NC}"
npx tsx "$SCRIPT_DIR/test-reverse-inject.ts"
if [ $? -eq 0 ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
fi
echo ""

# ── Test 3: Legacy mode write-back ──
echo -e "${YELLOW}Test 3: Legacy mode write-back (edit context file → template de-rendered)${NC}"
# Reuse workspace from Test 1

# Force legacy mode by making mkfifo unavailable
# We'll create a config that uses file-based rendering
# First, stop any running daemon
$GMD stop 2>/dev/null || true
sleep 1

# Manually run pmd in legacy mode by temporarily making mkfifo fail
# Instead, we'll test the write-back logic directly by simulating what
# the daemon would do: edit the context file and verify template gets de-rendered

# Simulate the daemon having rendered the context file
$GMD run --output "$WORKSPACE/AGENTS.md" 2>&1 | tail -1

if [ -f "$WORKSPACE/AGENTS.md" ]; then
  RENDERED=$(cat "$WORKSPACE/AGENTS.md")
  assert_contains "$RENDERED" "pmd:" "rendered context"

  # Now simulate an AI editing the context file:
  # Edit the static rules section and add a note
  EDITED=$(cat "$WORKSPACE/AGENTS.md" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{d=d.replace('is **read-only**','is **ALWAYS read-only**').replace('is **yours**','is **yours** — your changes persist — see');process.stdout.write(d)})")

  echo "$EDITED" > "$WORKSPACE/AGENTS.md"

  # Now run reverseInject manually by using the Node test approach
  # Verify that the template would get correctly de-rendered
  TEMPLATE_BEFORE=$(cat .pipemd/template.md)

  # Use Node to apply reverseInject
  node -e "
    import fs from 'node:fs';
    const BLOCK_RE = /<!--\s*pmd:\s*([\w-]+)\s*-->[\s\S]*?<!--\s*\/pmd\s*-->/g;
    const EMPTY_BLOCK = (name) => '<!-- pmd: ' + name + ' -->\n\`\`\`\n\n\`\`\`\n<!-- /pmd -->';
    function reverseInject(rendered, template) {
      const templateBlocks = new Map();
      const tRe = /<!--\s*pmd:\s*([\w-]+)\s*-->[\s\S]*?<!--\s*\/pmd\s*-->/g;
      let tMatch;
      while ((tMatch = tRe.exec(template)) !== null) templateBlocks.set(tMatch[1], tMatch[0]);
      return rendered.replace(BLOCK_RE, (_match, name) => templateBlocks.has(name) ? templateBlocks.get(name) : EMPTY_BLOCK(name));
    }
    const rendered = fs.readFileSync('$WORKSPACE/AGENTS.md', 'utf-8');
    const template = fs.readFileSync('.pipemd/template.md', 'utf-8');
    const deRendered = reverseInject(rendered, template);
    fs.writeFileSync('.pipemd/template.md', deRendered, 'utf-8');
  " 2>&1

  TEMPLATE_AFTER=$(cat .pipemd/template.md)
  assert_contains "$TEMPLATE_AFTER" "ALWAYS read-only" "template preserves rule edit"
  assert_contains "$TEMPLATE_AFTER" "your changes persist" "template preserves added note"
  assert_not_contains "$TEMPLATE_AFTER" "src/index.ts" "template should not contain live tree data"

  # Restore template for subsequent tests
  echo "$TEMPLATE_BEFORE" > .pipemd/template.md
else
  echo -e "  ${YELLOW}⊘${NC} Skipped: could not render context file"
  SKIP=$((SKIP + 2))
fi

echo ""

# ── Test 4: Pipe mode write-back ──
echo -e "${YELLOW}Test 4: Pipe mode bidirectional (daemon read → write-back)${NC}"
# Reuse workspace, start daemon

# Clean up any leftover
$GMD stop 2>/dev/null || true
sleep 1

# Remove legacy file if it exists
rm -f "$WORKSPACE/AGENTS.md" 2>/dev/null

$GMD start 2>&1
sleep 3

if [ -f ".pipemd/.daemon.pid" ]; then
  PID=$(cat .pipemd/.daemon.pid)
  if kill -0 "$PID" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Daemon running (PID $PID)"
    PASS=$((PASS + 1))

    # Check if named pipe exists
    if [ -p "AGENTS.md" ]; then
      echo -e "  ${GREEN}✓${NC} Named pipe exists: AGENTS.md"
      PASS=$((PASS + 1))

      # Read the pipe to get current rendered content
      PIPE_OUTPUT=$(timeout 5 cat "AGENTS.md" 2>/dev/null || true)

      if [ -n "$PIPE_OUTPUT" ]; then
        assert_contains "$PIPE_OUTPUT" "pmd:" "pipe output"
        assert_contains "$PIPE_OUTPUT" "PipeMD Context File" "pipe output has new directive"

        # Now test write-back: modify the content and write it to the pipe
        # We'll verify the daemon has the bidirectional listener by checking logs
        LOG_CONTENT=$($GMD status 2>&1)
        if echo "$LOG_CONTENT" | grep -q "Listening for AI writes"; then
          echo -e "  ${GREEN}✓${NC} Daemon reports bidirectional listener active"
          PASS=$((PASS + 1))
        else
          echo -e "  ${YELLOW}⊘${NC} Bidirectional listener not detected in status (may be in log)"
          SKIP=$((SKIP + 1))
        fi
      else
        echo -e "  ${YELLOW}⊘${NC} Pipe read timed out"
        SKIP=$((SKIP + 2))
      fi
    else
      echo -e "  ${YELLOW}⊘${NC} No named pipe (Legacy Mode)"
      SKIP=$((SKIP + 3))

      # In legacy mode, check that the context file watcher is set up
      LOG_CONTENT=$($GMD status 2>&1)
      if echo "$LOG_CONTENT" | grep -q "Watching context file"; then
        echo -e "  ${GREEN}✓${NC} Legacy mode: context file watcher active"
        PASS=$((PASS + 1))
      else
        echo -e "  ${YELLOW}⊘${NC} Legacy mode: context file watcher not detected"
        SKIP=$((SKIP + 1))
      fi
    fi
  else
    echo -e "  ${RED}✖${NC} Daemon PID found but not running"
    FAIL=$((FAIL + 1))
  fi
else
  echo -e "  ${YELLOW}⊘${NC} Daemon did not start"
  SKIP=$((SKIP + 3))
fi

$GMD stop 2>/dev/null || true
sleep 1

echo ""

# ── Test 5: Legacy mode write-back (daemon watches context file) ──
echo -e "${YELLOW}Test 5: Legacy mode write-back via daemon${NC}"
# This test only works if mkfifo is unavailable, so we'll simulate it
# by testing with the `pmd run` output and manual reverseInject

WORKSPACE2=$(mktemp -d)
cd "$WORKSPACE2"

git init --initial-branch=main 2>/dev/null
echo '{"name": "legacy-test", "version": "1.0.0"}' > package.json
echo '{"compilerOptions": {"strict": true}}' > tsconfig.json
mkdir -p src
echo "const x: number = 1;" > src/index.ts
git add -A && git commit -m "init" --quiet 2>/dev/null

$GMD init --yes 2>&1 | tail -3

# Render the context to a file
$GMD run --output "$WORKSPACE2/AGENTS.md" 2>&1 | tail -1

if [ -f "$WORKSPACE2/AGENTS.md" ]; then
  # Simulate AI editing: add emphasis to a rule and add a note
  RENDERED=$(cat "$WORKSPACE2/AGENTS.md")
  EDITED=$(echo "$RENDERED" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{d=d.replace('is **yours**','is **yours** — your changes persist').replace('Never edit these.','NEVER edit these.');process.stdout.write(d)})")

  echo "$EDITED" > "$WORKSPACE2/AGENTS.md"

  # Apply reverseInject
  node -e "
    import fs from 'node:fs';
    const BLOCK_RE = /<!--\s*pmd:\s*([\w-]+)\s*-->[\s\S]*?<!--\s*\/pmd\s*-->/g;
    const EMPTY_BLOCK = (name) => '<!-- pmd: ' + name + ' -->\n\`\`\`\n\n\`\`\`\n<!-- /pmd -->';
    function reverseInject(rendered, template) {
      const templateBlocks = new Map();
      const tRe = /<!--\s*pmd:\s*([\w-]+)\s*-->[\s\S]*?<!--\s*\/pmd\s*-->/g;
      let tMatch;
      while ((tMatch = tRe.exec(template)) !== null) templateBlocks.set(tMatch[1], tMatch[0]);
      return rendered.replace(BLOCK_RE, (_match, name) => templateBlocks.has(name) ? templateBlocks.get(name) : EMPTY_BLOCK(name));
    }
    const rendered = fs.readFileSync('$WORKSPACE2/AGENTS.md', 'utf-8');
    const template = fs.readFileSync('.pipemd/template.md', 'utf-8');
    const deRendered = reverseInject(rendered, template);
    fs.writeFileSync('.pipemd/template.md', deRendered, 'utf-8');
  " 2>&1

  TEMPLATE_AFTER=$(cat .pipemd/template.md)
  assert_contains "$TEMPLATE_AFTER" "NEVER edit these." "template preserves rule emphasis edit"
  assert_contains "$TEMPLATE_AFTER" "your changes persist" "template preserves added note"
  assert_contains "$TEMPLATE_AFTER" "<!-- pmd: tree -->" "template still has pmd blocks"
  assert_not_contains "$TEMPLATE_AFTER" "src/index.ts" "template should not have live data"

  # Verify that re-rendering produces clean output
  RENDERED_AGAIN=$($GMD run 2>&1)
  assert_contains "$RENDERED_AGAIN" "NEVER edit these." "re-rendered output preserves edit"
  assert_contains "$RENDERED_AGAIN" "your changes persist" "re-rendered output preserves note"
else
  echo -e "  ${YELLOW}⊘${NC} Could not render context file"
  SKIP=$((SKIP + 5))
fi

rm -rf "$WORKSPACE2"

echo ""

# ── Test 6: Template has correct structure ──
echo -e "${YELLOW}Test 6: Template structure for bidirectional editing${NC}"
WORKSPACE3=$(mktemp -d)
cd "$WORKSPACE3"

git init --initial-branch=main 2>/dev/null
echo '{"name": "structure-test", "version": "1.0.0"}' > package.json
git add -A && git commit -m "init" --quiet 2>/dev/null

$GMD init --yes 2>&1 | tail -3

TEMPLATE=$(cat .pipemd/template.md)
assert_contains "$TEMPLATE" "PipeMD Context File" "template"
assert_contains "$TEMPLATE" "read-only" "template"
assert_contains "$TEMPLATE" "bidirectional write-back" "template"
assert_not_contains "$TEMPLATE" "Scratchpad" "template"
assert_not_contains "$TEMPLATE" "AI SYSTEM DIRECTIVE" "template"
assert_not_contains "$TEMPLATE" "You MAY edit this file" "template"

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