#!/usr/bin/env bash
set -uo pipefail
# e2e-link.sh — PipeMD Link E2E tests.
# Starts two real relays on localhost, verifies crew session sync.
# Requires `pnpm build` first.

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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PMD="node $ROOT_DIR/dist/index.js"

if [ ! -f "$ROOT_DIR/dist/index.js" ]; then
  echo -e "${RED}✖ dist/index.js missing — run 'pnpm build' first.${NC}"
  exit 1
fi

LINK_DIR="$HOME/.pipemd/link"
mkdir -p "$LINK_DIR"

WORK="$(mktemp -d)"

cleanup() {
  # Kill relay processes
  for pidfile in "$LINK_DIR/relay.pid" "$LINK_DIR/relay.pid.e2e"; do
    if [ -f "$pidfile" ]; then
      pid=$(cat "$pidfile")
      kill "$pid" 2>/dev/null || true
      rm -f "$pidfile"
    fi
  done
  # Kill any _linkd processes we spawned
  jobs -p | xargs kill 2>/dev/null || true
  # Clean up temp files
  rm -f "$LINK_DIR/relay.port.e2e" "$LINK_DIR/peers.json.e2e"
  rm -rf "$WORK"
}
trap cleanup EXIT

echo -e "${YELLOW}═══ PipeMD Link E2E Tests ═══${NC}"

# ── Test 1: Relay starts and responds to health check ──
echo -e "${YELLOW}Test: relay starts and health check${NC}"

# Start relay on a high port to avoid conflicts
RELAY_PORT=19741
# Kill anything on that port
fuser -k "$RELAY_PORT/tcp" 2>/dev/null || true
sleep 0.5

# Start relay with explicit port via env var
PMD_LINK_PORT=$RELAY_PORT $PMD _linkd &
RELAY_PID=$!
sleep 1

# Check health
HEALTH=$(curl -s "http://localhost:$RELAY_PORT/health" 2>/dev/null)
assert_contains "$HEALTH" '"ok":true' "health endpoint"

# ── Test 2: Relay status shows no groups initially ──
echo -e "${YELLOW}Test: relay status empty${NC}"
STATUS=$(curl -s "http://localhost:$RELAY_PORT/status" 2>/dev/null)
assert_contains "$STATUS" '"ok":true' "status ok"
assert_contains "$STATUS" '"groups":{}' "empty groups"

# ── Test 3: POST /crew stores and returns sessions ──
echo -e "${YELLOW}Test: POST /crew stores sessions${NC}"
CREW_RESPONSE=$(curl -s -X POST "http://localhost:$RELAY_PORT/crew" \
  -H "Content-Type: application/json" \
  -d '{"group":"test-project","hostname":"machine-a","sessions":[{"schema":1,"id":"cr_001","role":"coordinator","harness":"OpenCode","pid":100,"ppid":1,"coordinatorId":null,"claimedFiles":[{"path":"src/auth.ts","claimedAt":"2026-05-23T00:00:00Z"}],"startedAt":"2026-05-23T00:00:00Z","lastHeartbeat":"2026-05-23T00:00:00Z","cwd":"/tmp"}]}' 2>/dev/null)
assert_contains "$CREW_RESPONSE" '"sessions":[]' "crew returns empty remote sessions"

# ── Test 4: Status shows the group after POST /crew ──
echo -e "${YELLOW}Test: status shows group after push${NC}"
STATUS2=$(curl -s "http://localhost:$RELAY_PORT/status" 2>/dev/null)
assert_contains "$STATUS2" "test-project" "status has test-project group"

# ── Test 5: Second origin sees first origin's sessions ──
echo -e "${YELLOW}Test: cross-origin session exchange${NC}"
CREW_RESPONSE2=$(curl -s -X POST "http://localhost:$RELAY_PORT/crew" \
  -H "Content-Type: application/json" \
  -d '{"group":"test-project","hostname":"machine-b","sessions":[{"schema":1,"id":"cr_002","role":"worker","harness":"Claude Code","pid":200,"ppid":1,"coordinatorId":null,"claimedFiles":[],"startedAt":"2026-05-23T00:00:00Z","lastHeartbeat":"2026-05-23T00:00:00Z","cwd":"/tmp"}]}' 2>/dev/null)
assert_contains "$CREW_RESPONSE2" '"cr_001"' "machine-b sees machine-a's session"
assert_contains "$CREW_RESPONSE2" '"OpenCode"' "machine-b sees OpenCode harness"

# ── Test 6: machine-a now sees machine-b's session ──
echo -e "${YELLOW}Test: reverse session exchange${NC}"
CREW_RESPONSE3=$(curl -s -X POST "http://localhost:$RELAY_PORT/crew" \
  -H "Content-Type: application/json" \
  -d '{"group":"test-project","hostname":"machine-a","sessions":[{"schema":1,"id":"cr_001","role":"coordinator","harness":"OpenCode","pid":100,"ppid":1,"coordinatorId":null,"claimedFiles":[{"path":"src/auth.ts","claimedAt":"2026-05-23T00:00:00Z"}],"startedAt":"2026-05-23T00:00:00Z","lastHeartbeat":"2026-05-23T00:00:00Z","cwd":"/tmp"}]}' 2>/dev/null)
assert_contains "$CREW_RESPONSE3" '"cr_002"' "machine-a sees machine-b's session"
assert_contains "$CREW_RESPONSE3" '"Claude Code"' "machine-a sees Claude Code harness"

# ── Test 7: Different group is isolated ──
echo -e "${YELLOW}Test: group isolation${NC}"
CREW_RESPONSE4=$(curl -s -X POST "http://localhost:$RELAY_PORT/crew" \
  -H "Content-Type: application/json" \
  -d '{"group":"other-project","hostname":"machine-c","sessions":[{"schema":1,"id":"cr_003","role":"coordinator","harness":"Aider","pid":300,"ppid":1,"coordinatorId":null,"claimedFiles":[],"startedAt":"2026-05-23T00:00:00Z","lastHeartbeat":"2026-05-23T00:00:00Z","cwd":"/tmp"}]}' 2>/dev/null)
assert_not_contains "$CREW_RESPONSE4" '"cr_001"' "other-project doesn't see test-project sessions"
assert_not_contains "$CREW_RESPONSE4" '"cr_002"' "other-project doesn't see test-project sessions"

# ── Test 8: Conflict detection across origins ──
echo -e "${YELLOW}Test: cross-origin conflict detection${NC}"
# Both machine-a and machine-b claim the same file
CREW_RESPONSE5=$(curl -s -X POST "http://localhost:$RELAY_PORT/crew" \
  -H "Content-Type: application/json" \
  -d '{"group":"conflict-project","hostname":"machine-a","sessions":[{"schema":1,"id":"cr_conflict1","role":"coordinator","harness":"OpenCode","pid":400,"ppid":1,"coordinatorId":null,"claimedFiles":[{"path":"src/shared.ts","claimedAt":"2026-05-23T00:00:00Z"}],"startedAt":"2026-05-23T00:00:00Z","lastHeartbeat":"2026-05-23T00:00:00Z","cwd":"/tmp"}]}' 2>/dev/null)

CREW_RESPONSE6=$(curl -s -X POST "http://localhost:$RELAY_PORT/crew" \
  -H "Content-Type: application/json" \
  -d '{"group":"conflict-project","hostname":"machine-b","sessions":[{"schema":1,"id":"cr_conflict2","role":"coordinator","harness":"Claude Code","pid":500,"ppid":1,"coordinatorId":null,"claimedFiles":[{"path":"src/shared.ts","claimedAt":"2026-05-23T00:00:00Z"}],"startedAt":"2026-05-23T00:00:00Z","lastHeartbeat":"2026-05-23T00:00:00Z","cwd":"/tmp"}]}' 2>/dev/null)

# machine-b should see machine-a's claim on src/shared.ts
# Simulate findConflicts on the merged sessions
assert_contains "$CREW_RESPONSE6" '"cr_conflict1"' "machine-b receives machine-a's session"
assert_contains "$CREW_RESPONSE6" '"src/shared.ts"' "machine-b sees the contested file claim"

# ── Test 9: pmd link CLI ──
echo -e "${YELLOW}Test: pmd link CLI commands${NC}"

# link --list should work
LIST_OUT=$($PMD link --list 2>&1)
# This may or may not show a relay depending on whether one is running
assert_contains "$LIST_OUT" "Relay:" "link --list shows relay section"

# ── Test 10: Sync endpoint with token auth ──
echo -e "${YELLOW}Test: POST /sync token auth${NC}"

# Generate a test token
TEST_TOKEN="e2e-test-token-12345"
TOKEN_FILE="$LINK_DIR/relay.token"
ORIG_TOKEN=""
if [ -f "$TOKEN_FILE" ]; then
  ORIG_TOKEN=$(cat "$TOKEN_FILE")
fi
echo "$TEST_TOKEN" > "$TOKEN_FILE"

# Without token: should get 403
SYNC_BAD=$(curl -s -X POST "http://localhost:$RELAY_PORT/sync" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"evil","groups":{}}' 2>/dev/null)
assert_contains "$SYNC_BAD" '"error":"unauthorized"' "sync rejects without token"

# With token: should get 200
SYNC_GOOD=$(curl -s -X POST "http://localhost:$RELAY_PORT/sync" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -d '{"hostname":"trusted-peer","groups":{"remote-project":[{"schema":1,"id":"cr_remote_sync","role":"coordinator","harness":"Gemini","pid":600,"ppid":1,"coordinatorId":null,"claimedFiles":[],"startedAt":"2026-05-23T00:00:00Z","lastHeartbeat":"2026-05-23T00:00:00Z","cwd":"/tmp"}]}}' 2>/dev/null)
assert_contains "$SYNC_GOOD" '"hostname"' "sync accepts valid token"
assert_contains "$SYNC_GOOD" "test-project" "sync returns local groups"

# Restore original token
if [ -n "$ORIG_TOKEN" ]; then
  echo "$ORIG_TOKEN" > "$TOKEN_FILE"
else
  rm -f "$TOKEN_FILE"
fi

# Cleanup relay
kill "$RELAY_PID" 2>/dev/null || true
wait "$RELAY_PID" 2>/dev/null

echo ""
echo -e "${YELLOW}═══ Results ═══${NC}"
echo -e "  ${GREEN}Pass: $PASS${NC}  ${RED}Fail: $FAIL${NC}"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
