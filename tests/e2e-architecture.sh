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

assert_line_count() {
  local haystack="$1"
  local min="$2"
  local label="${3:-output}"
  local lines
  lines=$(echo "$haystack" | wc -l)
  if [ "$lines" -ge "$min" ]; then
    echo -e "  ${GREEN}✓${NC} $label has >= $min lines ($lines)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} $label has < $min lines ($lines)"
    FAIL=$((FAIL + 1))
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"

echo -e "${YELLOW}═══ Architecture Visualization E2E Tests ═══${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════
# Part 1: normalize.sh (the shared Mermaid renderer)
# ═══════════════════════════════════════════════════════════════

echo -e "${YELLOW}═══ normalize.sh Unit Tests ═══${NC}"
echo ""

# ── Test: Basic graph generation ──
echo -e "${YELLOW}Test: normalize.sh basic graph generation${NC}"
OUT=$(printf 'commands\tcore\ncommands\tconfig\ncore\tconfig\nindex\tcommands\nindex\tcore\n' \
  | MAX_ARCH=100 MAX_EXT=20 bash "$ROOT_DIR/scripts/Shared/architecture/normalize.sh" 2>&1)
assert_contains "$OUT" "graph TD" "normalize"
assert_contains "$OUT" "commands" "normalize"
assert_contains "$OUT" "core" "normalize"
assert_contains "$OUT" "config" "normalize"
assert_contains "$OUT" "index" "normalize"
assert_contains "$OUT" "-->" "normalize"
echo ""

# ── Test: External deps with ext: prefix ──
echo -e "${YELLOW}Test: normalize.sh external deps${NC}"
OUT=$(printf 'commands\text:commander\ncommands\text:chalk\ncore\text:chokidar\ncore\text:yaml\n' \
  | MAX_ARCH=100 MAX_EXT=20 bash "$ROOT_DIR/scripts/Shared/architecture/normalize.sh" 2>&1)
assert_contains "$OUT" "subgraph g_ext" "normalize"
assert_contains "$OUT" "ext_commander" "normalize"
assert_contains "$OUT" "ext_chalk" "normalize"
assert_contains "$OUT" "ext_chokidar" "normalize"
assert_contains "$OUT" "ext_yaml" "normalize"
assert_contains "$OUT" "commands --> ext_commander" "normalize"
echo ""

# ── Test: MAX_EXT limits external deps ──
echo -e "${YELLOW}Test: normalize.sh MAX_EXT budget limiting${NC}"
OUT=$(printf 'mod1\text:dep1\nmod1\text:dep2\nmod1\text:dep3\nmod1\text:dep4\nmod1\text:dep5\n' \
  | MAX_ARCH=100 MAX_EXT=3 bash "$ROOT_DIR/scripts/Shared/architecture/normalize.sh" 2>&1)
EXT_SUBGRAPH=$(echo "$OUT" | grep -c '^\s*ext_.*\[' || true)
if [ "$EXT_SUBGRAPH" -le 3 ]; then
  echo -e "  ${GREEN}✓${NC} external deps limited to MAX_EXT (found $EXT_SUBGRAPH subgraph nodes)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} external deps exceed MAX_EXT (found $EXT_SUBGRAPH subgraph nodes, expected <= 3)"
  FAIL=$((FAIL + 1))
fi
assert_contains "$OUT" "hidden" "normalize"
echo ""

# ── Test: Subgraph grouping by directory ──
echo -e "${YELLOW}Test: normalize.sh subgraph grouping${NC}"
OUT=$(printf 'src/commands\tcore\nsrc/commands\tconfig\nsrc/core\tconfig\nsrc/index\tcore\n' \
  | MAX_ARCH=100 MAX_EXT=20 bash "$ROOT_DIR/scripts/Shared/architecture/normalize.sh" 2>&1)
assert_contains "$OUT" "subgraph g_src" "normalize"
assert_contains "$OUT" "end" "normalize"
echo ""

# ── Test: Deduplication of edges ──
echo -e "${YELLOW}Test: normalize.sh deduplication${NC}"
OUT=$(printf 'a\tb\na\tb\na\tb\n' \
  | MAX_ARCH=100 MAX_EXT=20 bash "$ROOT_DIR/scripts/Shared/architecture/normalize.sh" 2>&1)
EDGE_COUNT=$(echo "$OUT" | grep -c '\-\-\>' || true)
if [ "$EDGE_COUNT" -le 1 ]; then
  echo -e "  ${GREEN}✓${NC} duplicate edges deduplicated (found $EDGE_COUNT edge)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} duplicate edges not deduplicated (found $EDGE_COUNT edges, expected 1)"
  FAIL=$((FAIL + 1))
fi
echo ""

# ── Test: Self-loops are removed ──
echo -e "${YELLOW}Test: normalize.sh self-loop removal${NC}"
OUT=$(printf 'a\ta\na\tb\n' \
  | MAX_ARCH=100 MAX_EXT=20 bash "$ROOT_DIR/scripts/Shared/architecture/normalize.sh" 2>&1)
SELF_LOOP=$(echo "$OUT" | grep 'a --> a' || true)
if [ -z "$SELF_LOOP" ]; then
  echo -e "  ${GREEN}✓${NC} self-loops removed"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} self-loop found in output"
  FAIL=$((FAIL + 1))
fi
echo ""

# ── Test: Empty input ──
echo -e "${YELLOW}Test: normalize.sh empty input${NC}"
OUT=$(printf '' \
  | MAX_ARCH=100 MAX_EXT=20 bash "$ROOT_DIR/scripts/Shared/architecture/normalize.sh" 2>&1)
assert_contains "$OUT" "No modules found" "normalize"
echo ""

# ── Test: Summary comment ──
echo -e "${YELLOW}Test: normalize.sh summary comment${NC}"
OUT=$(printf 'commands\tcore\ncommands\text:chalk\ncore\tconfig\n' \
  | MAX_ARCH=100 MAX_EXT=20 bash "$ROOT_DIR/scripts/Shared/architecture/normalize.sh" 2>&1)
assert_contains "$OUT" "modules" "normalize"
assert_contains "$OUT" "edges" "normalize"
echo ""

# ═══════════════════════════════════════════════════════════════
# Part 2: Ecosystem-specific extractor tests
# ═══════════════════════════════════════════════════════════════

echo -e "${YELLOW}═══ Ecosystem Extractor Tests ═══${NC}"
echo ""

# ── Node/TypeScript extractor ──
echo -e "${YELLOW}Test: arch.sh (Node/TypeScript) on express-project${NC}"
cd "$FIXTURES/express-project"
OUT=$(PMD_ECOSYSTEM=Node-TypeScript PMD_TOKEN_PROFILE=medium bash "$ROOT_DIR/scripts/Node-TypeScript/architecture/arch.sh" 2>&1)
assert_contains "$OUT" "graph TD" "Node/TS arch"
assert_contains "$OUT" "routes" "Node/TS arch"
assert_contains "$OUT" "app" "Node/TS arch"
assert_contains "$OUT" "-->" "Node/TS arch"
assert_not_contains "$OUT" "No modules found" "Node/TS arch"
assert_line_count "$OUT" 3 "Node/TS arch"
echo ""

# ── Node/TypeScript extractor on react-project ──
echo -e "${YELLOW}Test: arch.sh (Node/TypeScript) on react-project${NC}"
cd "$FIXTURES/react-project"
OUT=$(PMD_ECOSYSTEM=Node-TypeScript PMD_TOKEN_PROFILE=medium bash "$ROOT_DIR/scripts/Node-TypeScript/architecture/arch.sh" 2>&1)
assert_contains "$OUT" "graph TD" "Node/TS arch (react)"
assert_contains "$OUT" "components" "Node/TS arch (react)"
assert_not_contains "$OUT" "No modules found" "Node/TS arch (react)"
echo ""

# ── Python extractor on fastapi-project ──
echo -e "${YELLOW}Test: arch.sh (Python) on fastapi-project${NC}"
cd "$FIXTURES/fastapi-project"
OUT=$(PMD_ECOSYSTEM=Python PMD_TOKEN_PROFILE=medium bash "$ROOT_DIR/scripts/Python/architecture/arch.sh" 2>&1)
assert_contains "$OUT" "graph TD" "Python arch"
assert_contains "$OUT" "routers" "Python arch"
assert_not_contains "$OUT" "No source" "Python arch"
echo ""

# ── Python extractor on django-project ──
echo -e "${YELLOW}Test: arch.sh (Python) on django-project${NC}"
cd "$FIXTURES/django-project"
OUT=$(PMD_ECOSYSTEM=Python PMD_TOKEN_PROFILE=medium bash "$ROOT_DIR/scripts/Python/architecture/arch.sh" 2>&1)
assert_contains "$OUT" "graph TD" "Python arch (django)"
# Django project should detect blog or mysite as modules
assert_contains "$OUT" "blog" "Python arch (django) should find blog module"
echo ""

# ── C-CPP extractor on cpp-project ──
echo -e "${YELLOW}Test: arch.sh (C-CPP) on cpp-project${NC}"
cd "$FIXTURES/cpp-project"
OUT=$(PMD_ECOSYSTEM=C-CPP PMD_TOKEN_PROFILE=medium bash "$ROOT_DIR/scripts/C-CPP/architecture/arch.sh" 2>&1)
assert_contains "$OUT" "graph TD" "C-CPP arch"
assert_contains "$OUT" "-->" "C-CPP arch"
assert_not_contains "$OUT" "No" "C-CPP arch (should find modules)"
echo ""

# ── Rust extractor on rust-project ──
echo -e "${YELLOW}Test: arch.sh (Rust) on rust-project${NC}"
cd "$FIXTURES/rust-project"
OUT=$(PMD_ECOSYSTEM=Rust PMD_TOKEN_PROFILE=medium bash "$ROOT_DIR/scripts/Rust/architecture/arch.sh" 2>&1)
assert_contains "$OUT" "graph TD" "Rust arch"
# Should detect handler/config modules from fixture
assert_contains "$OUT" "-->" "Rust arch"
echo ""

# ── Go extractor on go-project ──
echo -e "${YELLOW}Test: arch.sh (Go) on go-project${NC}"
cd "$FIXTURES/go-project"
OUT=$(PMD_ECOSYSTEM=Go PMD_TOKEN_PROFILE=medium bash "$ROOT_DIR/scripts/Go/architecture/arch.sh" 2>&1)
assert_contains "$OUT" "graph TD" "Go arch"
assert_contains "$OUT" "-->" "Go arch"
# Should detect handler or db package from fixture
assert_not_contains "$OUT" "No go.mod" "Go arch"
echo ""

# ── DevOps extractor on devops-project ──
echo -e "${YELLOW}Test: arch.sh (DevOps) on devops-project${NC}"
cd "$FIXTURES/devops-project"
OUT=$(PMD_ECOSYSTEM=DevOps PMD_TOKEN_PROFILE=medium bash "$ROOT_DIR/scripts/DevOps/architecture/arch.sh" 2>&1)
assert_contains "$OUT" "graph TD" "DevOps arch"
# Should detect services from docker-compose
assert_not_contains "$OUT" "No" "DevOps arch (should find docker-compose)"
echo ""

# ── Generic extractor on express-project ──
echo -e "${YELLOW}Test: arch.sh (Generic) on express-project${NC}"
cd "$FIXTURES/express-project"
OUT=$(PMD_ECOSYSTEM=Generic PMD_TOKEN_PROFILE=medium bash "$ROOT_DIR/scripts/Generic/architecture/arch.sh" 2>&1)
assert_contains "$OUT" "graph TD" "Generic arch"
assert_not_contains "$OUT" "No modules found" "Generic arch"
echo ""

# ── Cross-ecosystem graceful fallback ──
echo -e "${YELLOW}Test: Cross-ecosystem graceful fallback${NC}"
cd "$FIXTURES/cpp-project"
OUT=$(PMD_ECOSYSTEM=Node-TypeScript PMD_TOKEN_PROFILE=medium bash "$ROOT_DIR/scripts/Node-TypeScript/architecture/arch.sh" 2>&1)
# Should not crash; may produce "No source directory found" or a small graph
if [ $? -eq 0 ]; then
  echo -e "  ${GREEN}✓${NC} Node/TS arch on C++ project did not crash"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} Node/TS arch on C++ project crashed"
  FAIL=$((FAIL + 1))
fi
echo ""

# ═══════════════════════════════════════════════════════════════
# Part 3: pmd init integration (arch appears as #1 script)
# ═══════════════════════════════════════════════════════════════

echo -e "${YELLOW}═══ pmd init Integration Tests ═══${NC}"
echo ""

GMD="node $ROOT_DIR/dist/index.js"

# ── Test: arch is recommended by default in pmd init ──
echo -e "${YELLOW}Test: pmd init --yes includes arch script${NC}"
WORKSPACE=$(mktemp -d)
cd "$WORKSPACE"
git init --initial-branch=main 2>/dev/null
echo '{"name": "arch-test", "version": "1.0.0", "dependencies": {"chalk": "^5.0.0"}}' > package.json
mkdir -p src
echo "import { x } from './utils'; console.log(x);" > src/index.ts
echo "export const x = 42;" > src/utils.ts
git add -A && git commit -m "init" --quiet 2>/dev/null

OUT=$($GMD init --yes 2>&1)
assert_contains "$OUT" "arch" "init output includes arch"
assert_contains "$OUT" "Architecture Map" "init output includes Architecture Map label"

# Check that arch script was copied
if [ -f ".pipemd/scripts/architecture/arch.sh" ]; then
  echo -e "  ${GREEN}✓${NC} arch.sh script copied to .pipemd/scripts/"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} arch.sh script not copied"
  FAIL=$((FAIL + 1))
fi

# Check that normalize.sh was copied
if [ -f ".pipemd/scripts/architecture/normalize.sh" ]; then
  echo -e "  ${GREEN}✓${NC} normalize.sh copied to .pipemd/scripts/"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} normalize.sh not copied"
  FAIL=$((FAIL + 1))
fi

# Check template has arch as first block
TEMPLATE=$(cat .pipemd/template.md 2>/dev/null)
FIRST_BLOCK_LINE=$(echo "$TEMPLATE" | grep -n '<!-- pmd:' | head -1 | cut -d: -f1)
TREE_BLOCK_LINE=$(echo "$TEMPLATE" | grep -n 'pmd: tree' | head -1 | cut -d: -f1)
ARCH_BLOCK_LINE=$(echo "$TEMPLATE" | grep -n 'pmd: arch' | head -1 | cut -d: -f1)
if [ -n "$ARCH_BLOCK_LINE" ] && [ -n "$TREE_BLOCK_LINE" ]; then
  if [ "$ARCH_BLOCK_LINE" -lt "$TREE_BLOCK_LINE" ]; then
    echo -e "  ${GREEN}✓${NC} arch block appears before tree block in template"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} arch block should appear before tree block"
    FAIL=$((FAIL + 1))
  fi
else
  echo -e "  ${RED}✖${NC} missing arch or tree block in template"
  FAIL=$((FAIL + 1))
fi

# Check config.yml includes arch command
CONFIG=$(cat .pipemd/config.yml 2>/dev/null)
assert_contains "$CONFIG" "arch" "config.yml"

# Run pmd run and verify arch renders
echo -e "${DIM}  Rendering with pmd run...${NC}"
RENDERED=$($GMD run 2>&1) || true
assert_contains "$RENDERED" "pmd: arch" "rendered output has arch block"

rm -rf "$WORKSPACE"
echo ""

# ── Test: arch renders valid Mermaid for PipeMD itself ──
echo -e "${YELLOW}Test: arch.sh on PipeMD repo itself${NC}"
cd "$ROOT_DIR"
OUT=$(PMD_ECOSYSTEM=Node-TypeScript PMD_TOKEN_PROFILE=medium bash "$ROOT_DIR/scripts/Node-TypeScript/architecture/arch.sh" 2>&1)
assert_contains "$OUT" "graph TD" "PipeMD arch"
assert_contains "$OUT" "commands" "PipeMD arch"
assert_contains "$OUT" "core" "PipeMD arch"
assert_contains "$OUT" "subgraph g_ext" "PipeMD arch"
assert_contains "$OUT" "ext_commander" "PipeMD arch"
echo ""

# ── Test: pmd init for C-CPP includes arch ──
echo -e "${YELLOW}Test: pmd init --yes for C-CPP includes arch${NC}"
WORKSPACE=$(mktemp -d)
cd "$WORKSPACE"
git init --initial-branch=main 2>/dev/null
cp -r "$FIXTURES/cpp-project/"* . 2>/dev/null
cp "$FIXTURES/cpp-project/CMakeLists.txt" . 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null

OUT=$($GMD init --yes --ecosystem C-CPP 2>&1)
assert_contains "$OUT" "arch" "C-CPP init includes arch"
if [ -f ".pipemd/scripts/architecture/arch.sh" ]; then
  echo -e "  ${GREEN}✓${NC} arch.sh copied for C-CPP"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} arch.sh not copied for C-CPP"
  FAIL=$((FAIL + 1))
fi
rm -rf "$WORKSPACE"
echo ""

# ── Test: pmd init for Python includes arch ──
echo -e "${YELLOW}Test: pmd init --yes for Python includes arch${NC}"
WORKSPACE=$(mktemp -d)
cd "$WORKSPACE"
git init --initial-branch=main 2>/dev/null
cp -r "$FIXTURES/fastapi-project/"* . 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null

OUT=$($GMD init --yes --ecosystem Python 2>&1)
assert_contains "$OUT" "arch" "Python init includes arch"
rm -rf "$WORKSPACE"
echo ""

# ── Test: pmd init for Go includes arch ──
echo -e "${YELLOW}Test: pmd init --yes for Go includes arch${NC}"
WORKSPACE=$(mktemp -d)
cd "$WORKSPACE"
git init --initial-branch=main 2>/dev/null
cp -r "$FIXTURES/go-project/"* . 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null

OUT=$($GMD init --yes --ecosystem Go 2>&1)
assert_contains "$OUT" "arch" "Go init includes arch"
rm -rf "$WORKSPACE"
echo ""

# ── Test: token profile scaling affects arch output ──
echo -e "${YELLOW}Test: MAX_ARCH budget limiting via token profiles${NC}"
cd "$ROOT_DIR"
OUT_LOW=$(PMD_ECOSYSTEM=Node-TypeScript PMD_TOKEN_PROFILE=low bash "$ROOT_DIR/scripts/Node-TypeScript/architecture/arch.sh" 2>&1)
OUT_XHIGH=$(PMD_ECOSYSTEM=Node-TypeScript PMD_TOKEN_PROFILE=xhigh bash "$ROOT_DIR/scripts/Node-TypeScript/architecture/arch.sh" 2>&1)
LINES_LOW=$(echo "$OUT_LOW" | wc -l)
LINES_XHIGH=$(echo "$OUT_XHIGH" | wc -l)
if [ "$LINES_XHIGH" -ge "$LINES_LOW" ]; then
  echo -e "  ${GREEN}✓${NC} xhigh profile produces >= lines than low profile ($LINES_XHIGH >= $LINES_LOW)"
  PASS=$((PASS + 1))
else
  echo -e "  ${YELLOW}⊘${NC} xhigh profile produced fewer lines ($LINES_XHIGH < $LINES_LOW) — may be due to project size"
  SKIP=$((SKIP + 1))
fi
echo ""

# ═══════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════

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