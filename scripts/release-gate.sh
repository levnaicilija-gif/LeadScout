#!/usr/bin/env bash
# The full release gate. Run before every commit (CLAUDE.md, "Before every commit").
#
#   bash scripts/release-gate.sh [port]        # default port 3100
#
# Runs every step even after one fails, so a single run shows everything that is wrong, then exits 1
# if any step failed. The log is .cache/gate-<date>-<time>.log; screenshots go to .cache/shots.
set -u
PORT="${1:-3100}"
cd "$(dirname "$0")/.." || exit 1
mkdir -p .cache
LOG=".cache/gate-$(date +%Y%m%d-%H%M%S).log"
: > "$LOG"
FAILED=()

nap() { node -e "setTimeout(() => {}, $1)"; }
step() {
  local name="$1"; shift
  echo "=== $name" | tee -a "$LOG"
  "$@" >> "$LOG" 2>&1
  local code=$?
  if [ "$code" -eq 0 ]; then echo "    pass" | tee -a "$LOG"; else echo "    FAIL (exit $code)" | tee -a "$LOG"; FAILED+=("$name"); fi
}
killport() {
  for pid in $(netstat -ano 2>/dev/null | grep -E ":$PORT .*LISTENING" | awk '{print $NF}' | sort -u); do
    taskkill //PID "$pid" //F >/dev/null 2>&1 || kill "$pid" 2>/dev/null
  done
}

step typecheck npx tsc --noEmit
step build npx next build
# Straight after the build and before anything reads as a user. A table a signed-in user cannot read
# fails the gate here, whatever caused it: code, a migration, or a toggle in the Supabase dashboard.
RLS_SWEEP_SOURCE=gate step rls-sweep npx tsx --env-file=.env.local scripts/rls-sweep.ts
# Who may write users. A policy can exist and still be wrong: 0001's let any account change its own role,
# move itself into any workspace, and change or delete a teammate's row. 0028 closed it on 2026-09-14;
# this tries those writes with throwaway accounts and fails the gate if a migration or the dashboard reopens it.
step users-policy npx tsx --env-file=.env.local scripts/users-policy-probe.ts
step candidate-rls npx tsx --env-file=.env.local scripts/candidate-rls-probe.ts
step workspace-scope npx tsx --env-file=.env.local scripts/workspace-scope-check.ts
step compound-signals npx tsx scripts/compound-signals-check.ts
step phone-on npx tsx scripts/phone-on-check.ts
step winner-address npx tsx scripts/winner-address-check.ts
step site-scope npx tsx scripts/site-scope-check.ts
step site-trust npx tsx scripts/site-trust-check.ts
step model-meter npx tsx scripts/model-meter-check.ts
step verify-adapters npx tsx scripts/verify-adapters-check.ts
step candidate-search npx tsx scripts/candidate-search-check.ts
step candidate-dedupe npx tsx scripts/candidate-dedupe-check.ts
step candidate-phone npx tsx scripts/candidate-phone-check.ts

if [[ " ${FAILED[*]-} " == *" build "* ]]; then
  echo "=== the build failed, so nothing was served or tested against it" | tee -a "$LOG"
else
  # A stale server on the port serves old chunks and fails correct code.
  killport
  npx next start -p "$PORT" > ".cache/server-$PORT.log" 2>&1 &
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://localhost:$PORT/api/health" && break; nap 2000; done
  BASE="http://localhost:$PORT"
  step pdf-check env LEADSCOUT_TEST_RUN=pdf-check npx tsx --env-file=.env.local scripts/pdf-check.ts
  step pdf-name-audit npx tsx --env-file=.env.local scripts/pdf-name-audit.ts
  step verify-e2e npx tsx --env-file=.env.local scripts/verify-e2e.ts "$BASE"
  step lead-drawer-e2e npx tsx --env-file=.env.local scripts/lead-drawer-e2e.ts "$BASE"
  # Item 18: the industry entitlement is enforced by the server — by the session, the routes and 0032's trigger —
  # tried with throwaway accounts. Exit 2 means 0032 is not applied: nothing to enforce yet, reported, not passed.
  echo "=== industry-follow" | tee -a "$LOG"
  npx tsx --env-file=.env.local scripts/industry-follow-probe.ts "$BASE" >> "$LOG" 2>&1
  code=$?
  if [ "$code" -eq 0 ]; then echo "    pass" | tee -a "$LOG"
  elif [ "$code" -eq 2 ]; then echo "    not judged (0032 not applied)" | tee -a "$LOG"
  else echo "    FAIL (exit $code)" | tee -a "$LOG"; FAILED+=("industry-follow"); fi
  step smoke npx tsx --env-file=.env.local scripts/smoke.ts "$BASE"
  step design-shots env SCREEN_BASE="$BASE" SHOT_DIR=".cache/shots" npx tsx --env-file=.env.local scripts/design-shots.ts
  killport
fi

echo | tee -a "$LOG"
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "GATE FAILED: ${FAILED[*]} — details in $LOG" | tee -a "$LOG"
  exit 1
fi
echo "GATE PASSED — $LOG" | tee -a "$LOG"
