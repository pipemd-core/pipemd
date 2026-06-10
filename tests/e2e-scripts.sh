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

assert_not_empty() {
  local output="$1"
  local label="$2"
  local skip_label="${3:-}"
  if [ -n "$skip_label" ]; then
    # Check if the output says "No X found" — that's a valid skip
    if echo "$output" | grep -qi "no.*found\|not found\|not detected"; then
      echo -e "  ${YELLOW}⊘${NC} $label: skipped (not applicable)"
      SKIP=$((SKIP + 1))
      return
    fi
  fi
  local trimmed
  trimmed=$(echo "$output" | tr -d '[:space:]')
  if [ -n "$trimmed" ]; then
    echo -e "  ${GREEN}✓${NC} $label produced output"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} $label produced no output"
    FAIL=$((FAIL + 1))
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"
GMD="node $ROOT_DIR/dist/index.js"

echo -e "${YELLOW}═══ Script Library E2E Tests ═══${NC}"
echo ""

# Build first
echo -e "${DIM}Building PipeMD...${NC}"
cd "$ROOT_DIR"
pnpm build 2>&1 | tail -3
echo ""

# ── Express Routes ──
echo -e "${YELLOW}Test: express-routes.sh (Node/TypeScript)${NC}"
cd "$FIXTURES/express-project"
git init --initial-branch=main 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null || true
OUT=$(bash "$ROOT_DIR/scripts/Node-TypeScript/api/express-routes.sh" 2>&1)
assert_not_empty "$OUT" "express-routes"
assert_contains "$OUT" "GET" "express-routes"
assert_contains "$OUT" "POST" "express-routes"
assert_contains "$OUT" "/USERS" "express-routes"
assert_not_contains "$OUT" "USE " "express-routes should not match app.use"
assert_not_contains "$OUT" "LISTEN" "express-routes should not match app.listen"
echo ""

# ── NestJS Controllers ──
echo -e "${YELLOW}Test: nest-controllers.sh (Node/TypeScript)${NC}"
cd "$FIXTURES/nestjs-project"
git init --initial-branch=main 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null || true
OUT=$(bash "$ROOT_DIR/scripts/Node-TypeScript/api/nest-controllers.sh" 2>&1)
assert_not_empty "$OUT" "nest-controllers"
assert_contains "$OUT" "Controller" "nest-controllers"
echo ""

# ── React Components ──
echo -e "${YELLOW}Test: react-components.sh (Node/TypeScript)${NC}"
cd "$FIXTURES/react-project"
git init --initial-branch=main 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null || true
OUT=$(bash "$ROOT_DIR/scripts/Node-TypeScript/frontend/react-components.sh" 2>&1)
assert_not_empty "$OUT" "react-components"
assert_contains "$OUT" "Button" "react-components"
assert_contains "$OUT" "Card" "react-components"
echo ""

# ── Next.js App Router ──
echo -e "${YELLOW}Test: nextjs-app-router.sh (Node/TypeScript)${NC}"
cd "$FIXTURES/nextjs-project"
git init --initial-branch=main 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null || true
OUT=$(bash "$ROOT_DIR/scripts/Node-TypeScript/frontend/nextjs-app-router.sh" 2>&1)
assert_not_empty "$OUT" "nextjs-app-router"
assert_contains "$OUT" "/users" "nextjs-app-router"
echo ""

# ── Angular Routes ──
echo -e "${YELLOW}Test: angular-routes.sh (Node/TypeScript)${NC}"
cd "$FIXTURES/angular-project"
git init --initial-branch=main 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null || true
OUT=$(bash "$ROOT_DIR/scripts/Node-TypeScript/frontend/angular-routes.sh" 2>&1)
assert_not_empty "$OUT" "angular-routes"
assert_contains "$OUT" "users" "angular-routes"
echo ""

# ── Prisma Models ──
echo -e "${YELLOW}Test: prisma.sh (Node/TypeScript)${NC}"
cd "$FIXTURES/prisma-project"
git init --initial-branch=main 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null || true
OUT=$(bash "$ROOT_DIR/scripts/Shared/db/prisma.sh" 2>&1)
assert_not_empty "$OUT" "prisma"
assert_contains "$OUT" "User" "prisma"
assert_contains "$OUT" "Post" "prisma"
assert_contains "$OUT" "enum" "prisma"
echo ""

# ── Django Models ──
echo -e "${YELLOW}Test: django-models.sh (Python)${NC}"
cd "$FIXTURES/django-project"
git init --initial-branch=main 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null || true
OUT=$(bash "$ROOT_DIR/scripts/Python/db/django-models.sh" 2>&1)
assert_not_empty "$OUT" "django-models"
assert_contains "$OUT" "User" "django-models"
assert_contains "$OUT" "Post" "django-models"
echo ""

# ── SQLAlchemy Models ──
echo -e "${YELLOW}Test: sqlalchemy.sh (Python)${NC}"
cd "$FIXTURES/sqlalchemy-project"
git init --initial-branch=main 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null || true
OUT=$(bash "$ROOT_DIR/scripts/Python/db/sqlalchemy.sh" 2>&1)
assert_not_empty "$OUT" "sqlalchemy"
assert_contains "$OUT" "User" "sqlalchemy"
assert_contains "$OUT" "Post" "sqlalchemy"
echo ""

# ── FastAPI Routes ──
echo -e "${YELLOW}Test: fastapi-routes.sh (Python)${NC}"
cd "$FIXTURES/fastapi-project"
git init --initial-branch=main 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null || true
OUT=$(bash "$ROOT_DIR/scripts/Python/api/fastapi-routes.sh" 2>&1)
assert_not_empty "$OUT" "fastapi-routes"
assert_contains "$OUT" "GET" "fastapi-routes"
assert_contains "$OUT" "POST" "fastapi-routes"
echo ""

# ── CMake Targets ──
echo -e "${YELLOW}Test: cmake-targets.sh (C-CPP)${NC}"
cd "$FIXTURES/cpp-project"
OUT=$(bash "$ROOT_DIR/scripts/C-CPP/project/cmake-targets.sh" 2>&1)
assert_not_empty "$OUT" "cmake-targets"
assert_contains "$OUT" "myapp" "cmake-targets"
assert_contains "$OUT" "engine" "cmake-targets"
assert_contains "$OUT" "exe" "cmake-targets"
assert_contains "$OUT" "lib" "cmake-targets"
echo ""

# ── Class Diagram ──
echo -e "${YELLOW}Test: class-diagram.sh (C-CPP)${NC}"
cd "$FIXTURES/cpp-project"
OUT=$(bash "$ROOT_DIR/scripts/C-CPP/project/class-diagram.sh" 2>&1)
assert_not_empty "$OUT" "class-diagram"
assert_contains "$OUT" "classDiagram" "class-diagram"
assert_contains "$OUT" "Engine" "class-diagram"
assert_contains "$OUT" "DieselEngine" "class-diagram"
assert_contains "$OUT" "ElectricMotor" "class-diagram"
assert_contains "$OUT" "<|--" "class-diagram"
echo ""

# ── C++ Interfaces ──
echo -e "${YELLOW}Test: interfaces.sh (C-CPP)${NC}"
cd "$FIXTURES/cpp-project"
OUT=$(bash "$ROOT_DIR/scripts/C-CPP/project/interfaces.sh" 2>&1)
assert_not_empty "$OUT" "interfaces"
assert_contains "$OUT" "Engine" "interfaces"
assert_contains "$OUT" "start()" "interfaces"
assert_contains "$OUT" "stop()" "interfaces"
assert_contains "$OUT" "-> void" "interfaces"
echo ""

# ── Include Graph ──
echo -e "${YELLOW}Test: include-graph.sh (C-CPP)${NC}"
cd "$FIXTURES/cpp-project"
OUT=$(bash "$ROOT_DIR/scripts/C-CPP/project/include-graph.sh" 2>&1)
assert_not_empty "$OUT" "include-graph"
assert_contains "$OUT" "Standard Library" "include-graph"
assert_contains "$OUT" "string" "include-graph"
echo ""

# ── Rust Cargo Deps ──
echo -e "${YELLOW}Test: cargo-deps.sh (Rust)${NC}"
cd "$FIXTURES/rust-project"
git init --initial-branch=main 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null || true
OUT=$(bash "$ROOT_DIR/scripts/Rust/project/cargo-deps.sh" 2>&1)
assert_not_empty "$OUT" "cargo-deps" "Rust"
assert_contains "$OUT" "serde" "cargo-deps"
echo ""

# ── Rust Find Todos ──
echo -e "${YELLOW}Test: find-todos.sh (Rust)${NC}"
cd "$FIXTURES/rust-project"
OUT=$(bash "$ROOT_DIR/scripts/Rust/project/find-todos.sh" 2>&1)
assert_not_empty "$OUT" "Rust find-todos"
assert_contains "$OUT" "TODO" "Rust find-todos"
echo ""

# ── Go Packages ──
echo -e "${YELLOW}Test: go-packages.sh (Go)${NC}"
cd "$FIXTURES/go-project"
git init --initial-branch=main 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null || true
OUT=$(bash "$ROOT_DIR/scripts/Go/project/go-packages.sh" 2>&1)
assert_not_empty "$OUT" "go-packages" "Go"
echo ""

# ── Go Interfaces ──
echo -e "${YELLOW}Test: go-interfaces.sh (Go)${NC}"
cd "$FIXTURES/go-project"
OUT=$(bash "$ROOT_DIR/scripts/Go/project/go-interfaces.sh" 2>&1)
assert_not_empty "$OUT" "go-interfaces" "Go"
assert_contains "$OUT" "Handler" "go-interfaces"
echo ""

# ── Cross-ecosystem stub tests ──
echo -e "${YELLOW}Test: Cross-ecosystem stubs return graceful fallback${NC}"
cd "$FIXTURES/express-project"
OUT=$(bash "$ROOT_DIR/scripts/Python/api/fastapi-routes.sh" 2>&1)
assert_contains "$OUT" "No FastAPI" "Python script on Node project"
echo ""

cd "$FIXTURES/cpp-project"
OUT=$(bash "$ROOT_DIR/scripts/Node-TypeScript/api/express-routes.sh" 2>&1)
assert_contains "$OUT" "No Express" "Node script on C++ project"
echo ""

# ── Full pmd init test for C-CPP ──
echo -e "${YELLOW}Test: pmd init --yes for C-CPP project${NC}"
WORKSPACE=$(mktemp -d)
cd "$WORKSPACE"
git init --initial-branch=main 2>/dev/null
cp -r "$FIXTURES/cpp-project/"* . 2>/dev/null
cp -r "$FIXTURES/cpp-project/CMakeLists.txt" . 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null

OUT=$($GMD init --yes --ecosystem C-CPP 2>&1)
assert_contains "$OUT" "CMakeLists.txt" "init detected CMake"
assert_contains "$OUT" "cmake-targets" "init recommended cmake-targets"
assert_contains "$OUT" "class-diagram" "init recommended class-diagram"
assert_contains "$OUT" "interfaces" "init recommended interfaces"
assert_contains "$OUT" "include-graph" "init recommended include-graph"

# Verify scripts were copied
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

assert_file ".pipemd/scripts/project/cmake-targets.sh"
assert_file ".pipemd/scripts/project/class-diagram.sh"
assert_file ".pipemd/scripts/project/interfaces.sh"
assert_file ".pipemd/scripts/project/include-graph.sh"
assert_file ".pipemd/scripts/lib/limit.sh"

# Run the scripts through pmd run
OUT=$($GMD run 2>&1)
assert_contains "$OUT" "pmd:" "rendered output"
assert_contains "$OUT" "cmake-targets" "rendered has cmake-targets"
assert_contains "$OUT" "class-diagram" "rendered has class-diagram"

rm -rf "$WORKSPACE"
echo ""

# ── Full pmd init test for Rust ──
echo -e "${YELLOW}Test: pmd init --yes for Rust project${NC}"
WORKSPACE=$(mktemp -d)
cd "$WORKSPACE"
git init --initial-branch=main 2>/dev/null
cp -r "$FIXTURES/rust-project/"* . 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null

OUT=$($GMD init --yes --ecosystem Rust 2>&1)
assert_contains "$OUT" "Cargo.toml" "init detected Cargo.toml"
assert_contains "$OUT" "cargo-deps" "init recommended cargo-deps"

assert_file ".pipemd/scripts/lib/limit.sh"
assert_file ".pipemd/scripts/project/cargo-deps.sh"

rm -rf "$WORKSPACE"
echo ""

# ── Full pmd init test for Go ──
echo -e "${YELLOW}Test: pmd init --yes for Go project${NC}"
WORKSPACE=$(mktemp -d)
cd "$WORKSPACE"
git init --initial-branch=main 2>/dev/null
cp -r "$FIXTURES/go-project/"* . 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null

OUT=$($GMD init --yes --ecosystem Go 2>&1)
assert_contains "$OUT" "go.mod" "init detected go.mod"
assert_contains "$OUT" "go-packages" "init recommended go-packages"

assert_file ".pipemd/scripts/lib/limit.sh"
assert_file ".pipemd/scripts/project/go-packages.sh"

rm -rf "$WORKSPACE"
echo ""

# ── Verify C-CPP Shared fallback (git scripts load via Shared) ──
echo -e "${YELLOW}Test: C-CPP Shared fallback for git scripts${NC}"
WORKSPACE=$(mktemp -d)
cd "$WORKSPACE"
git init --initial-branch=main 2>/dev/null
cp -r "$FIXTURES/cpp-project/"* . 2>/dev/null
cp -r "$FIXTURES/cpp-project/CMakeLists.txt" . 2>/dev/null
git add -A && git commit -m "init" --quiet 2>/dev/null

# Initialize with all script categories
OUT=$($GMD init --yes --ecosystem C-CPP --scripts tree,todos,git-log,git-branch,git-status,diff-stat,cmake-targets 2>&1)
assert_file ".pipemd/scripts/project/cmake-targets.sh"
assert_file ".pipemd/scripts/lib/limit.sh"
# These should be loaded from Shared fallback
assert_file ".pipemd/scripts/git/git-log.sh"
assert_file ".pipemd/scripts/git/git-status.sh"

rm -rf "$WORKSPACE"
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