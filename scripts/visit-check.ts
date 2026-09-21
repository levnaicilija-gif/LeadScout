/**
 * Today's visit window: the boundary holds still while you work, and only a real absence moves it.
 *
 * Pure — no database, no model, no network. In the release gate.
 *
 * The owner's decision of 2026-09-17 is what this pins down: the stamp advances on Today's load and
 * only after more than thirty minutes away. The case that matters most is the reload — a recruiter
 * refreshing Today twenty minutes later must still see the same "while you were out" window, not an
 * empty one.
 *
 *   npx tsx scripts/visit-check.ts
 */
import { visitWindow, lastHereLabel, whileOut, sinceArrived, clock, VISIT_GAP_MS } from '../src/lib/visit';

let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const at = (s: string) => new Date(s);

/* ------------------------------------------------------------------ a real absence */
const overnight = visitWindow('2026-09-17T17:04:00Z', at('2026-09-18T08:00:00Z'));
check(overnight.since?.toISOString() === '2026-09-17T17:04:00.000Z', 'after a night away the boundary is where they left', String(overnight.since?.toISOString()));
check(overnight.advance, 'and the stamp advances to this visit');
check(overnight.arrived.toISOString() === '2026-09-18T08:00:00.000Z', 'this visit began now', overnight.arrived.toISOString());

/* ------------------------------------------- the reload: the window must NOT collapse */
const reload = visitWindow('2026-09-18T08:00:00Z', at('2026-09-18T08:20:00Z'));
check(!reload.advance, 'a reload twenty minutes later writes nothing');
check(reload.since?.toISOString() === '2026-09-18T08:00:00.000Z', 'and the boundary stays exactly where it was', String(reload.since?.toISOString()));
check(reload.arrived.toISOString() === '2026-09-18T08:00:00.000Z', 'the live window still counts from when they arrived, not from the reload');

/* ------------------------------------------------------------- the boundary of the rule */
const justUnder = visitWindow('2026-09-18T08:00:00Z', new Date(Date.parse('2026-09-18T08:00:00Z') + VISIT_GAP_MS - 1000));
check(!justUnder.advance, 'a second under thirty minutes is still the same visit');
const justOver = visitWindow('2026-09-18T08:00:00Z', new Date(Date.parse('2026-09-18T08:00:00Z') + VISIT_GAP_MS + 1000));
check(justOver.advance, 'a second over it is a new one');

/* ------------------------------------------------------------------- the first ever visit */
const first = visitWindow(null, at('2026-09-18T08:00:00Z'));
check(first.since === null, 'a first visit has no "while you were out"');
check(first.advance, 'but it does set the stamp');
check(lastHereLabel(null, at('2026-09-18T08:00:00Z')) === 'first time here', 'and says so plainly');
const nonsense = visitWindow('not a date', at('2026-09-18T08:00:00Z'));
check(nonsense.since === null && nonsense.advance, 'an unreadable stamp is treated as a first visit, never as a crash');

/* ------------------------------------------------------------------------ the label */
check(/yesterday at \d\d:\d\d/.test(lastHereLabel(at('2026-09-17T17:04:00Z'), at('2026-09-18T08:00:00Z'))),
  'yesterday is named as yesterday', lastHereLabel(at('2026-09-17T17:04:00Z'), at('2026-09-18T08:00:00Z')));
check(!/yesterday/.test(lastHereLabel(at('2026-09-18T06:00:00Z'), at('2026-09-18T08:00:00Z'))),
  'earlier today is not called yesterday', lastHereLabel(at('2026-09-18T06:00:00Z'), at('2026-09-18T08:00:00Z')));
check(/Tuesday|Monday|Wednesday|Thursday|Friday|Saturday|Sunday/.test(lastHereLabel(at('2026-09-15T09:00:00Z'), at('2026-09-18T08:00:00Z'))),
  'longer ago is named by its day', lastHereLabel(at('2026-09-15T09:00:00Z'), at('2026-09-18T08:00:00Z')));

/* ------------------------------------------------------------- splitting the queue in two */
const items = [
  { when: '2026-09-17T16:00:00Z', what: 'before they left' },
  { when: '2026-09-17T18:30:00Z', what: 'while out, evening' },
  { when: '2026-09-18T07:15:00Z', what: 'while out, morning' },
  { when: '2026-09-18T08:14:00Z', what: 'since they arrived' },
  { when: null, what: 'undated' },
];
const out = whileOut(items, overnight.since, overnight.arrived);
const now = sinceArrived(items, overnight.arrived);
check(out.length === 2 && out.every((i) => i.what.startsWith('while out')), 'only what happened between leaving and arriving is "while you were out"', JSON.stringify(out.map((i) => i.what)));
check(now.length === 1 && now[0].what === 'since they arrived', 'and only what happened after arriving is in the live window', JSON.stringify(now.map((i) => i.what)));
check(!out.some((i) => i.when === null) && !now.some((i) => i.when === null), 'an undated item appears in neither window rather than in both');
check(whileOut(items, null, overnight.arrived).length === 0, 'a first-ever visit has nothing in the out window');

/* ------------------------------------------- 0043: the boundary survives the whole visit
 *
 * ONE column could not hold both "when this visit started" and "when the previous one did", so every
 * reload inside a visit read its own arrival as the boundary and the window shrank to the last few
 * minutes. Today runs LiveRefresh every five minutes, so that was not an edge case — it was the
 * normal state of the page for all but the first five minutes of a session.
 *
 * previous_visit_at (0043) holds the boundary; last_seen_at holds this visit's arrival. The three
 * states of the third argument are tested here because the difference between `undefined` and `null`
 * is load-bearing: one is "the migration is not applied", the other is "there was no previous visit".
 */
const held = visitWindow('2026-09-18T08:00:00Z', at('2026-09-18T08:20:00Z'), '2026-09-17T17:04:00Z');
check(held.since?.toISOString() === '2026-09-17T17:04:00.000Z',
  'with 0043, a reload keeps yesterday evening as the boundary instead of this morning', String(held.since?.toISOString()));
check(!held.advance, 'and it still writes nothing mid-visit');
check(held.arrived.toISOString() === '2026-09-18T08:00:00.000Z', 'while the live window still counts from when they arrived');

// The pre-0043 answer, kept passing on purpose: a screen on an unapplied migration must behave exactly
// as it did before, never worse. This is the same case the reload check above already pins.
check(visitWindow('2026-09-18T08:00:00Z', at('2026-09-18T08:20:00Z')).since?.toISOString() === '2026-09-18T08:00:00.000Z',
  'without the column the boundary is this visit, exactly as before 0043 — narrower, never wrong');

// And the case that would put a brand-new recruiter's SECOND page load behind an empty window.
const secondEver = visitWindow('2026-09-18T08:00:00Z', at('2026-09-18T08:20:00Z'), null);
check(secondEver.since === null,
  'a column that exists and holds nothing means no previous visit — not "your own arrival"', String(secondEver.since));
check(whileOut(items, secondEver.since, secondEver.arrived).length === 0, 'so nothing is claimed to have happened while they were out');

// A real absence still names the stamp it is about to replace — which is what the route copies into
// previous_visit_at. If this ever returned `previousVisit` the boundary would go backwards a visit.
const moved = visitWindow('2026-09-18T08:00:00Z', at('2026-09-18T09:30:00Z'), '2026-09-17T17:04:00Z');
check(moved.advance && moved.since?.toISOString() === '2026-09-18T08:00:00.000Z',
  'a new visit counts from the PREVIOUS arrival, not from the older boundary it is replacing', String(moved.since?.toISOString()));
const nonsenseBefore = visitWindow('2026-09-18T08:00:00Z', at('2026-09-18T08:20:00Z'), 'not a date');
check(nonsenseBefore.since === null, 'an unreadable previous visit is treated as none, never as a crash');

/* --------------------------------------------------------------------------- the clock */
check(/^\d\d:\d\d$/.test(clock(at('2026-09-18T08:00:00Z'))), 'the clock label is HH:MM', clock(at('2026-09-18T08:00:00Z')));

console.log(failed ? `\nvisit check: ${failed} FAILED` : '\nvisit check: all checks passed');
process.exit(failed ? 1 : 0);
