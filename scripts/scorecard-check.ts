/**
 * Item 11 part 3: the scorecard states counts, and compares only where a real target exists.
 *
 * Pure — no database, no model, no network. In the release gate.
 *
 * The rule under test is the owner's decision of 2026-09-16: no warmth gradient. The same plain
 * standard whether the day was empty or busy; a denominator only where a senior set one; and no
 * adjective anywhere, because a tone that varies with the numbers teaches people to read the tone.
 *
 *   npx tsx scripts/scorecard-check.ts
 */
import { lines, readLine, summary, anyTarget, dayBounds, LABELS, type CountKey } from '../src/lib/scorecard';

let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const zero: Record<CountKey, number> = {
  packs_prepared: 0, cvs_sent: 0, outreach_sent: 0, verifications: 0, leads_confirmed: 0, candidates_added: 0,
};
const busy: Record<CountKey, number> = {
  packs_prepared: 3, cvs_sent: 2, outreach_sent: 4, verifications: 2, leads_confirmed: 1, candidates_added: 1,
};

/* ------------------------------------------------------------- no targets set: counts alone */
const noTargets = lines(busy, null);
check(noTargets.every((l) => l.target === null), 'with nothing set, every line has a null target — not a target of 0');
check(readLine(noTargets[0]) === '3', 'a line with no target reads as the count alone', readLine(noTargets[0]));
check(!anyTarget(null) && !anyTarget({}), 'a screen can tell that no target has been set');
check(!/0 of 0/.test(summary(noTargets)), 'it never reads "0 of 0", which looks like failing a target nobody set');

/* ---------------------------------------------------------- targets set: a factual comparison */
const withTargets = lines(busy, { packs_prepared: 5, cvs_sent: 4, verifications: null });
check(readLine(withTargets[0]) === '3 of 5', 'a line with a target reads as a fact, "3 of 5"', readLine(withTargets[0]));
check(withTargets[3].target === null && readLine(withTargets[3]) === '2',
  'a target left null on one line leaves that line counting alone', readLine(withTargets[3]));
check(anyTarget({ packs_prepared: 5 }), 'a single target counts as targets being set');
check(anyTarget({ packs_prepared: null }) === false, 'a null target does not count as set');

/* --------------------------------------------------- the zero day is held to the same standard */
const empty = lines(zero, null);
check(readLine(empty[0]) === '0', 'a day with nothing on it reads "0" — no consolation, no encouragement');
const zeroText = summary(empty);
check(!/(great|good|well done|quiet|fresh|tomorrow|keep|nice|solid|progress)/i.test(zeroText),
  'no adjective and no encouragement anywhere in the empty day', zeroText.slice(0, 120));
const busyText = summary(lines(busy, { packs_prepared: 5 }));
check(!/(great|good|well done|strong|excellent|nice|solid|progress|on track)/i.test(busyText),
  'and none in the busy day either — the standard does not soften once there are numbers', busyText.slice(0, 120));
check(zeroText.replace(/\d+/g, 'N') === summary(lines(busy, null)).replace(/\d+/g, 'N'),
  'empty and busy days differ only in their numbers, never in their wording');

/* ------------------------------------------------------------------------ shape and ordering */
check(lines(zero, null).length === 6, 'six lines, one per counted thing');
check(lines(zero, null).map((l) => l.key).join(',') === Object.keys(LABELS).join(','),
  'the order is fixed, so a recruiter reads the same list every day');
check(lines(zero, null).every((l) => l.from.length > 0), 'every line says what it is read from');

/* ------------------------------------------------------------------------------ the day itself */
const b = dayBounds('2026-09-16');
check(b.from === '2026-09-16T00:00:00.000Z' && b.to === '2026-09-17T00:00:00.000Z',
  'a day is [midnight, next midnight), so a timestamp and a date column agree', `${b.from} → ${b.to}`);

/* ------------------------------------------------------------------------------- the caveats */
const withCaveat = lines(busy, null, { verifications: 'counted through who uploaded the document' });
check(withCaveat[3].caveat === 'counted through who uploaded the document',
  'a count that cannot be attributed exactly carries its caveat onto the screen');
check(withCaveat[0].caveat === undefined, 'a count that is exact carries none');

console.log(failed ? `\nscorecard check: ${failed} FAILED` : '\nscorecard check: all checks passed');
process.exit(failed ? 1 : 0);
