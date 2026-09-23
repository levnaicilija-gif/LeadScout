/**
 * The bullet audit records what it did, and the record answers the question it exists for.
 *
 *   npx tsx scripts/bullet-audit-check.ts
 *
 * Pure: no database, no network, no model call — both model calls are injected, the same way
 * job-matches.ts injects its comparison. The real thing is two Sonnet calls per round and up to
 * three rounds; a test that paid for that per assertion would not be run.
 *
 * WHY IT MATTERS. buildBullets is the guard that stops an invented line reaching a client, and it is
 * the slowest thing in a CV drop — 52 s of the 116 s measured on 2026-09-22. The obvious saving is
 * to cap it at two rounds, and over 295 runs a third round runs in 6% of them. Whether those 6% are
 * where the guard earns its keep COULD NOT BE ANSWERED: `dropped` went to the browser and was
 * forgotten. These four shapes are what 0045 now stores, and the assertions below are that each one
 * is distinguishable from the others — because if a clean third round looks like a clean first
 * round, a week of real data still answers nothing.
 */
import { buildBullets } from '../src/lib/ai/documents';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const THREE = ['one', 'two', 'three'];
/** A generator that always returns three bullets. */
const generate = (async () => ({ bullets: [...THREE] })) as any;
const rewrite = (async (_c: string, kept: string[]) => [...kept, ...THREE.filter((b) => !kept.includes(b))]) as any;
/** An auditor that rejects the bullets at `badByRound[n]` on round n, then nothing. */
const auditor = (badByRound: number[][]) => {
  let round = 0;
  return (async (bullets: string[]) => {
    const bad = new Set(badByRound[round++] ?? []);
    return { results: bullets.map((_, i) => ({ i, supported: !bad.has(i), unsupported: bad.has(i) ? ['x'] : [] })) };
  }) as any;
};

(async () => {
  console.log('--- clean first time: 74% of runs ---');
  const a = await buildBullets({}, [], undefined, { generate, rewrite, audit: auditor([[]]) });
  check(a.rounds === 1, 'one round', String(a.rounds));
  check(a.dropped.length === 0, 'nothing dropped');
  check(JSON.stringify(a.audit) === JSON.stringify([{ round: 1, bad: 0 }]), 'and the trail says so', JSON.stringify(a.audit));

  console.log('\n--- the second round fixed it: 20% ---');
  const b = await buildBullets({}, [], undefined, { generate, rewrite, audit: auditor([[1], []]) });
  check(b.rounds === 2, 'two rounds', String(b.rounds));
  check(b.dropped.length === 0, 'nothing dropped — the rewrite satisfied the audit');
  check(JSON.stringify(b.audit) === JSON.stringify([{ round: 1, bad: 1 }, { round: 2, bad: 0 }]), 'the trail shows it converging', JSON.stringify(b.audit));

  console.log('\n--- THE QUESTION: the third round caught what the second missed ---');
  const c = await buildBullets({}, [], undefined, { generate, rewrite, audit: auditor([[0], [2], []]) });
  check(c.rounds === 3, 'three rounds ran', String(c.rounds));
  check(c.dropped.length === 0, 'and nothing was dropped — so the third round EARNED its keep');
  check(JSON.stringify(c.audit) === JSON.stringify([{ round: 1, bad: 1 }, { round: 2, bad: 1 }, { round: 3, bad: 0 }]), 'the trail shows each round', JSON.stringify(c.audit));

  console.log('\n--- its complement: three rounds and it still gave up ---');
  const d = await buildBullets({}, [], undefined, { generate, rewrite, audit: auditor([[0], [0], [0]]) });
  check(d.rounds === 3, 'three rounds ran', String(d.rounds));
  check(d.dropped.length === 1, 'and a bullet WAS dropped — so the third round did not save it', JSON.stringify(d.dropped));
  check(d.bullets.length === 2, 'two true bullets beat three with a lie', String(d.bullets.length));

  console.log('\n--- the four shapes are distinguishable, which is the whole point ---');
  const shape = (x: any) => `${x.rounds}/${x.dropped.length ? 'dropped' : 'clean'}`;
  const shapes = [shape(a), shape(b), shape(c), shape(d)];
  check(new Set(shapes).size === 4, 'each outcome has its own signature', shapes.join(', '));
  check(shape(c) !== shape(a), 'a clean THIRD round is not mistaken for a clean first — the distinction the old data could not make', `${shape(c)} vs ${shape(a)}`);
  check(shape(c) !== shape(d), 'and a third round that worked is not mistaken for one that gave up', `${shape(c)} vs ${shape(d)}`);

  console.log('\n--- nothing about the guard itself changed ---');
  check(a.bullets.length === 3 && c.bullets.length === 3, 'a satisfied audit still returns three bullets');
  // NOT "'one' is gone": the stub rewrite rotates the set, so by round 3 the rejected bullet is a
  // different one and 'one' is correctly returned. Asserting the literal would have been asserting
  // the stub's behaviour rather than the guard's. What must hold is that whatever WAS dropped is
  // not also returned.
  check(d.dropped.every((x: string) => !d.bullets.includes(x)),
    'and an unsupported bullet is still removed, not returned', `dropped ${JSON.stringify(d.dropped)}, returned ${JSON.stringify(d.bullets)}`);

  console.log(failures ? `\nbullet audit: ${failures} FAILED` : '\nbullet audit: all checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
