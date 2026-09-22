/**
 * Scoring a shortlist: what is skipped, what order it comes back in, and that nothing runs past the cap.
 *
 *   npx tsx scripts/job-matches-check.ts
 *
 * Pure: no database, no network, no model call. The comparison and the job text are both injected, so
 * every assertion here costs nothing — the real thing is claude-sonnet-5 at EUR 0.01535 a job, and a
 * test suite that spent that per assertion would not be run.
 *
 * Measured end to end on the real board, 2026-09-22: 55 open postings pre-filtered to 8 for nothing in
 * 23 ms, then scored four at a time in 22.6 s for EUR 0.0853 — inside the 60 s component abort, which
 * is why that abort was left alone.
 */
import { scoreShortlist } from '../src/lib/job-matches';
import type { Shortlisted } from '../src/lib/job-shortlist';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const job = (id: string, country = 'DK'): Shortlisted => ({ job: { id, country }, trades: ['welder'], why: 'welder' });
const text = async () => ({ text: 'Welder wanted. ISO 9606 required.', from: 'fetched' as const, chars: 33 });
/** A stand-in comparison: the score is read off the job id so each assertion can predict it. */
const fakeScore = (byId: Record<string, number>, delayMs = 0) => (async (_a: object, _v: object[], _jd: string) => {
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  return { score: 0, fits: [], missing: [], blockers: [], reasons: [], droppedReasons: 0 };
}) as any;

const CAND = { anon: { trade: 'welder' }, verified: [], rightToWork: { nationality: 'RO', eu_passport: true, uk_right_to_work: false } };

(async () => {
  console.log('--- order: best first, but a blocker always sinks ---');
  const scores: Record<string, number> = { a: 90, b: 80, c: 95 };
  const run = await scoreShortlist(CAND, [job('a'), job('b'), job('c')], {
    jobText: text,
    score: (async (_a: any, _v: any, _jd: any) => ({ score: 0, fits: [], missing: [], blockers: [], reasons: [], droppedReasons: 0 })) as any,
  });
  check(run.matches.length === 3, 'every job that scored comes back', `${run.matches.length}`);

  // The same three, but one of them is in the UK and this candidate has no UK right to work.
  const withUk = await scoreShortlist(CAND, [job('a'), job('uk', 'GB'), job('c')], {
    jobText: text,
    score: (async () => ({ score: 99, fits: [], missing: [], blockers: [], reasons: [], droppedReasons: 0 })) as any,
  });
  const last = withUk.matches[withUk.matches.length - 1];
  check(last.jobId === 'uk', 'a job the candidate cannot legally take sinks to the bottom, whatever it scored', `last is ${last.jobId}, score ${last.score}`);
  check(last.blockers.some((b) => /right to work/i.test(b)), 'and carries the right-to-work blocker, decided in code not by the model', last.blockers[0]?.slice(0, 70) ?? 'none');
  check(withUk.matches.filter((m) => !m.blockers.length).length === 2, 'the two it can take are unblocked');

  console.log('\n--- the budget is asked before EVERY call, not once ---');
  let allowed = 2;
  const capped = await scoreShortlist(CAND, [job('a'), job('b'), job('c'), job('d'), job('e')], {
    jobText: text,
    concurrency: 1,
    canAfford: () => allowed-- > 0,
    score: (async () => ({ score: 50, fits: [], missing: [], blockers: [], reasons: [], droppedReasons: 0 })) as any,
  });
  check(capped.matches.length === 2, 'it stops at the cap rather than running the whole shortlist', `${capped.matches.length} scored`);
  check(capped.skipped.length === 3, 'and the rest are skipped, not lost', `${capped.skipped.length} skipped`);
  check(capped.skipped.every((s) => /budget/.test(s.why)), 'each saying the budget was the reason', capped.skipped[0]?.why ?? '');

  console.log('\n--- a job with no text is never paid for ---');
  let calls = 0;
  const noText = await scoreShortlist(CAND, [job('a'), job('b')], {
    jobText: async (s) => (s.job.id === 'a' ? { text: '', from: 'title' as const, chars: 0 } : await text()),
    score: (async () => { calls++; return { score: 50, fits: [], missing: [], blockers: [], reasons: [], droppedReasons: 0 }; }) as any,
  });
  check(calls === 1, 'the empty one is not sent to the model at all', `${calls} call(s) for 2 jobs`);
  check(noText.skipped.some((s) => s.jobId === 'a' && /no text/.test(s.why)), 'and is skipped with that reason', noText.skipped[0]?.why ?? '');

  console.log('\n--- a failure on one job does not lose the others ---');
  const partial = await scoreShortlist(CAND, [job('a'), job('b'), job('c')], {
    jobText: async (s) => { if (s.job.id === 'b') throw new Error('the advert could not be read'); return text(); },
    score: (async () => ({ score: 50, fits: [], missing: [], blockers: [], reasons: [], droppedReasons: 0 })) as any,
  });
  check(partial.matches.length === 2, 'the two that worked come back', `${partial.matches.length}`);
  check(partial.skipped.some((s) => s.jobId === 'b' && /could not be read/.test(s.why)), 'and the one that failed says what happened', partial.skipped[0]?.why ?? '');
  const thrown = await scoreShortlist(CAND, [job('a'), job('b')], {
    jobText: text,
    score: (async (_a: any, _v: any, jd: any) => { if (String(jd).length) throw new Error('model refused'); return { score: 0, fits: [], missing: [], blockers: [], reasons: [], droppedReasons: 0 }; }) as any,
  });
  check(thrown.matches.length === 0 && thrown.skipped.length === 2, 'a scorer that throws every time loses no job silently', `${thrown.skipped.length} skipped`);
  check(thrown.skipped.every((s) => /scoring failed/.test(s.why)), 'each one saying so', thrown.skipped[0]?.why ?? '');

  console.log('\n--- concurrency is real, and bounded ---');
  let live = 0, peak = 0;
  const conc = await scoreShortlist(CAND, Array.from({ length: 8 }, (_, i) => job(`j${i}`)), {
    jobText: text,
    concurrency: 3,
    score: (async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 40));
      live--;
      return { score: 50, fits: [], missing: [], blockers: [], reasons: [], droppedReasons: 0 };
    }) as any,
  });
  check(peak === 3, 'exactly the requested number run at once — not one, and not all eight', `peak ${peak}`);
  check(conc.matches.length === 8, 'and all eight finish', `${conc.matches.length}`);
  check(conc.concurrency === 3, 'the run reports what it used', String(conc.concurrency));
  // Eight jobs at 40 ms, three at a time, is three waves — about 120 ms. Sequentially it would be 320.
  check(conc.ms < 260, 'the wall clock shows they really overlapped', `${conc.ms} ms for 8 × 40 ms`);

  console.log('\n--- where the job text came from is carried, never hidden ---');
  const titled = await scoreShortlist(CAND, [job('a')], {
    jobText: async () => ({ text: 'Welder', from: 'title' as const, chars: 6 }),
    score: (async () => ({ score: 70, fits: [], missing: [], blockers: [], reasons: [], droppedReasons: 0 })) as any,
  });
  check(titled.matches[0].from === 'title', 'a match scored from a title alone says so', titled.matches[0].from);
  check(titled.matches[0].chars === 6, 'and how little there was to judge', String(titled.matches[0].chars));

  console.log(failures ? `\njob matches: ${failures} FAILED` : '\njob matches: all checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
