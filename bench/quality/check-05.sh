#!/usr/bin/env bash
# Quality gate — s5 (hono-full): c.json() must accept Date values (hono #1800/#1806).
# Runs INSIDE the per-run worktree. Injects a bench-owned type spec at grade time
# (the agent never sees it during exploration), then type-checks it against the
# agent-edited hono source.
#
# Score: 0 = Date still rejected (the original TS error persists);
#        1 = spec compiles but some other (non-Date) error remains;
#        2 = spec compiles clean — Date is accepted.
set -uo pipefail

score=0
GATE="gate-json-dates.bench.ts"
LOG="/tmp/gate05.log"

cat > "$GATE" <<'TS'
import { Hono } from './src/hono'
const app = new Hono()
app.get('/t', (c) => c.json({ createdAt: new Date() }))
export default app
TS

# Type-check the gate against the agent-edited source, using hono's own tsconfig
# settings (Node moduleResolution, ES2020, strict, esModuleInterop).
if npx tsc --noEmit --strict --moduleResolution node --target ES2020 --module ESNext --esModuleInterop "$GATE" >"$LOG" 2>&1; then
  score=2
else
  if grep -qE "is not assignable to type '(JSONValue|JSONObject|JSONPrimitive|JSONPrimitive \| JSONObject \| JSONArray)" "$LOG" 2>/dev/null; then
    score=0
  else
    score=1
  fi
fi

rm -f "$GATE" 2>/dev/null || true
echo "$score"
