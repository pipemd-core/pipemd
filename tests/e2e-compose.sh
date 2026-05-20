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

assert_line_count_max() {
  local haystack="$1"
  local max="$2"
  local label="${3:-output}"
  local lines
  lines=$(echo "$haystack" | wc -l)
  if [ "$lines" -le "$max" ]; then
    echo -e "  ${GREEN}✓${NC} $label has <= $max lines ($lines)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✖${NC} $label has > $max lines ($lines)"
    FAIL=$((FAIL + 1))
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"
COMPOSE="$ROOT_DIR/scripts/Shared/project/compose-md.sh"

echo -e "${YELLOW}═══ Compose-md E2E Tests ═══${NC}"
echo ""

# ── Monorepo fixture ──
echo -e "${YELLOW}Test: compose-md on monorepo-project${NC}"
cd "$FIXTURES/monorepo-project"
OUT=$(PMD_TOKEN_PROFILE=medium bash "$COMPOSE" 2>&1)

assert_contains "$OUT" "### README.md" "monorepo" "root README header"
assert_contains "$OUT" "### CONTRIBUTING.md" "monorepo" "other root md header"
assert_contains "$OUT" "### apps/web/README.md" "monorepo" "sub-README header"
assert_contains "$OUT" "### packages/ui/README.md" "monorepo" "packages README header"
assert_contains "$OUT" "### services/api/README.md" "monorepo" "services README header"
assert_contains "$OUT" "My Monorepo" "monorepo" "root README content"
assert_contains "$OUT" "Web App" "monorepo" "web README content"
assert_contains "$OUT" "files composed" "monorepo" "summary line"
assert_line_count "$OUT" 20 "monorepo output"

# ── Ordering: root README comes before sub-READMEs ──
echo -e "${YELLOW}Test: compose-md ordering${NC}"
ROOT_POS=$(echo "$OUT" | grep -n "### README.md" | head -1 | cut -d: -f1)
SUB_POS=$(echo "$OUT" | grep -n "### apps/web/README.md" | head -1 | cut -d: -f1)
if [ -n "$ROOT_POS" ] && [ -n "$SUB_POS" ] && [ "$ROOT_POS" -lt "$SUB_POS" ]; then
  echo -e "  ${GREEN}✓${NC} root README appears before sub-READMEs"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✖${NC} root README should appear before sub-READMEs"
  FAIL=$((FAIL + 1))
fi

# ── Exclusion of output files ──
echo -e "${YELLOW}Test: compose-md excludes output files${NC}"
cd "$FIXTURES/monorepo-project"
# Create an AGENTS.md that should be excluded
echo "# Should not appear" > AGENTS.md
git add AGENTS.md 2>/dev/null
OUT_WITH_AGENTS=$(PMD_TOKEN_PROFILE=medium bash "$COMPOSE" 2>&1)
assert_not_contains "$OUT_WITH_AGENTS" "### AGENTS.md" "exclusion"
# Cleanup
git rm -f AGENTS.md >/dev/null 2>&1

# ── Budget enforcement (low profile) ──
echo -e "${YELLOW}Test: compose-md budget enforcement (low profile)${NC}"
cd "$FIXTURES/monorepo-project"
OUT_LOW=$(PMD_TOKEN_PROFILE=low bash "$COMPOSE" 2>&1)
assert_line_count_max "$OUT_LOW" 100 "low profile output"

# ── Non-git directory ──
echo -e "${YELLOW}Test: compose-md on non-git directory${NC}"
TMPDIR=$(mktemp -d)
OUT_NOGIT=$(cd "$TMPDIR" && PMD_TOKEN_PROFILE=medium bash "$COMPOSE" 2>&1)
assert_contains "$OUT_NOGIT" "Not a git repository" "non-git"
rm -rf "$TMPDIR"

# ── PipeMD project itself ──
echo -e "${YELLOW}Test: compose-md on PipeMD project${NC}"
cd "$ROOT_DIR"
OUT_PMD=$(PMD_TOKEN_PROFILE=medium bash "$COMPOSE" 2>&1)
assert_contains "$OUT_PMD" "### README.md" "pipemd" "README header"
assert_contains "$OUT_PMD" "PipeMD" "pipemd" "README content"
assert_not_contains "$OUT_PMD" "### .pipemd" "pipemd" "no .pipemd files"
assert_line_count "$OUT_PMD" 10 "pipemd output"

echo ""
echo -e "${YELLOW}═══ Results ═══${NC}"
echo -e "  ${GREEN}Pass: $PASS${NC}  ${RED}Fail: $FAIL${NC}  ${YELLOW}Skip: $SKIP${NC}"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi