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
step cv-sent-entry npx tsx scripts/cv-sent-entry-check.ts
step holder-fits npx tsx scripts/holder-fits-check.ts
step previous-employer npx tsx scripts/previous-employer-check.ts
step why-score npx tsx scripts/why-score-check.ts
step scorecard npx tsx scripts/scorecard-check.ts
step screening npx tsx scripts/screening-check.ts
step visit npx tsx scripts/visit-check.ts
step cert-schemes npx tsx scripts/cert-schemes-check.ts
# Item 12's award gate: CPV-or-(buyer AND CPV division 45/50). Both arms — the Energinet-shaped awards
# it must now keep, and the town councils, roads, rail and Energinet's own insurance it must still
# reject. Pure rules against fixed records: no database, no network, no model call.
step trade-buyers npx tsx scripts/trade-buyers-check.ts
step tender-gate npx tsx scripts/tender-gate-check.ts
# Every source type is read by exactly one pipeline. A missing .neq() is one forgotten clause that
# reads as harmless and breaks nothing loudly: for weeks radar crawled the nine enabled job boards as
# news and stored 92 of their pages as articles, while the board pipeline itself was scheduled by
# nothing at all. Source-reading only: no database, no network, no model call.
step source-routing npx tsx scripts/source-routing-check.ts
# A board that cannot be read costs ONE attempt a day, not every attempt for ever. The stamp used to
# sit at the end of the try, so an unreadable index hit continue, was never marked read, stayed first
# in the nullsFirst queue and was picked again next tick: sixty batches in one day, all the same dead
# board, while the eight behind it were never touched. Source-reading only, no database.
step board-rotation npx tsx scripts/board-rotation-check.ts
# A printed expiry becomes the right date or no date at all, never a plausible wrong one.
# verifications.valid_until is a Postgres date and the lookup route used to hand it the string copied
# off the document, so Postgres parsed it MDY: a European certificate printed 03.09.2028 was stored as
# 2028-03-09, six months early, on the column every expiry alert reads. Pure, no database.
step printed-date npx tsx scripts/printed-date-check.ts
# Item 8: received / verified / missing / expired, per document TYPE, because they are not the same
# states. Only a certificate has a register behind it, so only a certificate can be verified; a
# passport has nothing to check against and received is its ceiling. Making a passport verifiable
# would block every campaign that requires one, for ever — which is the mutation this was proved by.
step campaign-docs npx tsx scripts/campaign-docs-check.ts
# Item 8: 60 / 30 / 7 against verifications.valid_until - the only normalised date a certificate has -
# and a renewal message that is really drafted. Today carried an expiring-certificate item whose
# sub-line read Renewal message drafted while nothing drafted one: the word renewal appeared nowhere
# else in src. Pure, no database.
step cert-renewal npx tsx scripts/cert-renewal-check.ts
# Item 8: an expired certificate takes somebody off the roles that need it and off nothing else.
# Per role, because availability_from is a date meaning free from and there is no per-role field;
# computed and never stored, like lead age; and LAPSED is not NEVER HELD - somebody who never had a
# CSWIP is missing it, not unavailable, and treating the two alike flags everybody. Pure, no database.
step cert-availability npx tsx scripts/cert-availability-check.ts
# Item 25: the cheap pre-filter that decides which jobs are worth paying to score a candidate
# against. The comparison it feeds is claude-sonnet-5 at EUR 0.01535 and 12.8 s A JOB, measured -
# EUR 3.75 to score one dropped CV against every open lead and posting, nearly twice the daily cap.
# A filter that quietly keeps everything does not fail loudly, it spends the budget on the first CV
# of the morning, so the checks are about what is DROPPED. Pure, no database, no model call.
step job-shortlist npx tsx scripts/job-shortlist-check.ts
# Item 25: scoring the shortlist concurrently, inside the cap. The comparison and the job text are
# both INJECTED, so what this asserts - what is skipped, what order answers come back in, that a
# blocked job never outranks one the candidate can take, that the budget is asked before EVERY call
# rather than once - costs nothing, where the real thing is EUR 0.01535 a job. Pure, no database.
step job-matches npx tsx scripts/job-matches-check.ts
step scorecard-rls npx tsx --env-file=.env.local scripts/scorecard-rls-probe.ts
step screening-rls npx tsx --env-file=.env.local scripts/screening-rls-probe.ts
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
  # Today's queue item opens the leads it names and nothing else: ?ids= on each tab, the cross-link between
  # the two halves, "Clear filter" back to the whole list, and both tabs unchanged with no ids at all.
  step queue-ids npx tsx --env-file=.env.local scripts/queue-ids-probe.ts "$BASE"
  # Today itself: the three cards, the four tool cards, the visit split, the follow-up round trip — and from
  # 2026-09-18 the view toggle, including the check that no anchor sits inside another one, which is what took
  # Today down at 390px. This probe existed since the redesign and was NEVER a gate step: every screen it
  # covers was verified by running it by hand, so a regression on Today would have reached production with a
  # green gate behind it. It says which path it ran (0042 applied or not), so a pass names what it covered.
  step today npx tsx --env-file=.env.local scripts/today-probe.ts "$BASE"
  # Priority since 2026-09-21: the window is the reader's own last visit, one row per lead, no cap.
  # Decoys both ways — a lead two minutes inside the boundary must show, one two minutes before it
  # must not, and it carries the HIGHEST fit of the set so a surviving cap keeps it and fails loudly.
  # It also drives /api/me/visit for real and reads users.last_seen_at back: that write had answered
  # 42501 permission denied on every load since 0042 and nothing could see it, because today-probe
  # seeds the stamp with the service role. Exit 2 means 0042 is not applied: nothing to judge.
  echo "=== priority-window" | tee -a "$LOG"
  npx tsx --env-file=.env.local scripts/priority-window-probe.ts "$BASE" >> "$LOG" 2>&1
  code=$?
  if [ "$code" -eq 0 ]; then echo "    pass" | tee -a "$LOG"
  elif [ "$code" -eq 2 ]; then echo "    not judged (0042 not applied)" | tee -a "$LOG"
  else echo "    FAIL (exit $code)" | tee -a "$LOG"; FAILED+=("priority-window"); fi
  # Certificate check: one drop zone, certificates only, nobody created or touched — and Verify unchanged.
  # It drops a real CV to prove the refusal, so one classification call per gate run is spent on purpose; the
  # probe's workspace is marked is_test, so that spend is logged and not counted against the daily cap.
  step certificate npx tsx --env-file=.env.local scripts/certificate-probe.ts "$BASE"
  # Item 8: the campaign table shows the state each required document is actually in, and counts who
  # could go. Every state is SEEDED, because none exists in the real data - candidates, campaigns and
  # sends are all empty and the documents on file are attached to nobody, so a probe reading
  # production here would assert nothing and pass. Six people, one per state, including the two a
  # careless implementation gets wrong: an expired certificate beside a valid one, and an expiry that
  # was never normalised into a real date.
  step campaign-probe npx tsx --env-file=.env.local scripts/campaign-docs-probe.ts "$BASE"
  # Item 8: certificates raised at 60, 30 and 7 days and once gone, each with the renewal message
  # actually written out. Five distances are seeded because the real data has none - the candidates
  # table is empty - plus one whose expiry exists only as printed text, which must raise NOTHING.
  # That last one is protected twice over: the query cannot match a NULL valid_until, and thresholdFor
  # refuses text it cannot read. It takes breaking BOTH to make the probe fail, which it does.
  step cert-expiry npx tsx --env-file=.env.local scripts/cert-expiry-probe.ts "$BASE"
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
