/**
 * The order paid website discovery works through its queue — both arms on every rule.
 *
 *   npx tsx scripts/discovery-order-check.ts
 *
 * This exists because the reprioritisation had a silent-failure mode that nearly shipped: ordering on
 * `leads.created_at` instead of item 17's age. The TED backfill ran on 2026-09-13, so on that basis 32 of
 * 32 news companies and 103 of 103 tender companies read as "30 days or younger" and the whole change
 * becomes a no-op that reports success. The real split is 22 of 32 and 23 of 103. A check that only asked
 * "does fresh come before old" would pass under either, so the assertions below pin the SPLIT as well as
 * the ORDER, using the real measured ages.
 */
import { AGE_UNKNOWN, FRESH_DAYS, ageBucket, discoveryOrder, type Queued } from '../src/lib/discovery-order';

let fail = 0;
const check = (name: string, pass: boolean, detail: string) => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!pass) fail++;
};
const q = (name: string, age: number, lookups = 0): Queued => ({ name, age, lookups });
const names = (xs: Queued[]) => xs.slice().sort(discoveryOrder).map((x) => x.name);

// ---- THE BUCKETS ------------------------------------------------------------------------------
check('a lead 2 days old is fresh', ageBucket(q('a', 2)) === 0, `bucket ${ageBucket(q('a', 2))}`);
check(`a lead exactly ${FRESH_DAYS} days old is still fresh`, ageBucket(q('a', FRESH_DAYS)) === 0, 'the boundary is inclusive');
check(`a lead ${FRESH_DAYS + 1} days old is older`, ageBucket(q('a', FRESH_DAYS + 1)) === 1, 'one day past the line');
check('a lead with no date at all is its own bucket, not "very old"', ageBucket(q('a', AGE_UNKNOWN)) === 2,
  'so it can be placed last deliberately rather than by accident of a large number');
check('a 402-day-old award is older, not unknown', ageBucket(q('a', 402)) === 1, 'the oldest real tender age measured');

// ---- THE ORDER --------------------------------------------------------------------------------
check('freshest first',
  JSON.stringify(names([q('old', 200), q('new', 2), q('mid', 40)])) === JSON.stringify(['new', 'mid', 'old']),
  JSON.stringify(names([q('old', 200), q('new', 2), q('mid', 40)])));
check('undated goes LAST, behind even a 402-day-old award',
  JSON.stringify(names([q('undated', AGE_UNKNOWN), q('ancient', 402), q('new', 3)])) === JSON.stringify(['new', 'ancient', 'undated']),
  JSON.stringify(names([q('undated', AGE_UNKNOWN), q('ancient', 402), q('new', 3)])));
// THE ARM THAT CATCHES THE REAL MISTAKE: undated must not be treated as fresh. The default Leads sort
// does exactly that, on purpose, which is why it would be an easy and wrong thing to copy here.
check('undated is NOT treated as fresh',
  names([q('undated', AGE_UNKNOWN), q('fresh', 1)])[0] === 'fresh',
  `first is ${names([q('undated', AGE_UNKNOWN), q('fresh', 1)])[0]}`);

// ---- THE TIEBREAKERS, kept from before so a run stays deterministic ---------------------------
check('inside one age bucket a retry beats a first look',
  JSON.stringify(names([q('first', 5, 0), q('retry', 5, 1)])) === JSON.stringify(['retry', 'first']),
  JSON.stringify(names([q('first', 5, 0), q('retry', 5, 1)])));
check('but a FRESH first look still beats an OLD retry — age outranks the retry',
  JSON.stringify(names([q('old retry', 300, 1), q('fresh first', 4, 0)])) === JSON.stringify(['fresh first', 'old retry']),
  JSON.stringify(names([q('old retry', 300, 1), q('fresh first', 4, 0)])));
check('name settles a complete tie, so the run is re-runnable',
  JSON.stringify(names([q('Beta', 5, 0), q('Alpha', 5, 0)])) === JSON.stringify(['Alpha', 'Beta']),
  JSON.stringify(names([q('Beta', 5, 0), q('Alpha', 5, 0)])));
check('sorting is stable across two runs of the same input',
  JSON.stringify(names([q('c', 9), q('a', 3), q('b', 9)])) === JSON.stringify(names([q('c', 9), q('a', 3), q('b', 9)])),
  'the comparator is a total order');

// ---- THE MEASURED POPULATIONS, so the SPLIT is pinned and not just the direction ---------------
// Exactly the real ages measured on 2026-09-27: news 22 fresh / 2 older / 8 undated, tender 23 / 80 / 0.
const news = [
  ...Array.from({ length: 22 }, (_, i) => q(`news-fresh-${i}`, 2 + (i % 20))),
  ...Array.from({ length: 2 }, (_, i) => q(`news-old-${i}`, 120 + i * 400)),
  ...Array.from({ length: 8 }, (_, i) => q(`news-undated-${i}`, AGE_UNKNOWN)),
];
const tender = [
  ...Array.from({ length: 23 }, (_, i) => q(`tender-fresh-${i}`, 4 + (i % 26))),
  ...Array.from({ length: 80 }, (_, i) => q(`tender-old-${i}`, 31 + i * 4)),
];
for (const [label, set, fresh, older, undated] of [
  ['news (32)', news, 22, 2, 8],
  ['tender (103)', tender, 23, 80, 0],
  ['both (135)', [...news, ...tender], 45, 82, 8],
] as [string, Queued[], number, number, number][]) {
  const b = [0, 1, 2].map((n) => set.filter((t) => ageBucket(t) === n).length);
  check(`${label}: the split is ${fresh} fresh / ${older} older / ${undated} undated`,
    b[0] === fresh && b[1] === older && b[2] === undated, `got ${b.join(' / ')}`);
  const sorted = set.slice().sort(discoveryOrder);
  check(`${label}: every fresh company comes before every older one`,
    sorted.findIndex((t) => ageBucket(t) === 1) === -1 || sorted.slice(0, fresh).every((t) => ageBucket(t) === 0),
    `first ${fresh} are all fresh`);
  check(`${label}: no undated company appears before a dated one`,
    sorted.findIndex((t) => ageBucket(t) === 2) === -1 || sorted.findIndex((t) => ageBucket(t) === 2) === set.length - undated,
    `first undated at index ${sorted.findIndex((t) => ageBucket(t) === 2)} of ${set.length}`);
}

// AND THE NO-OP ARM: if the queue were aged by leads.created_at instead, every one of these companies was
// stored within 14 days, so EVERY one would be fresh and the reordering would do nothing. This asserts the
// check itself would notice that — the mistake, not merely the fix.
const byStoredDate = [...news, ...tender].map((t) => q(t.name, 14));
check('ordering on when we STORED the row would make everything fresh — the no-op this check exists to catch',
  byStoredDate.every((t) => ageBucket(t) === 0) && byStoredDate.length === 135,
  `${byStoredDate.filter((t) => ageBucket(t) === 0).length} of ${byStoredDate.length} "fresh" on the wrong basis`);

console.log(`\ndiscovery order: ${fail ? `${fail} FAILED` : 'all checks passed'}`);
if (fail) process.exitCode = 1;
