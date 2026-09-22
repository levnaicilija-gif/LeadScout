/**
 * A board that cannot be read costs one attempt a day, not every attempt for ever.
 *
 *   npx tsx scripts/board-rotation-check.ts
 *
 * Source-reading, like model-meter-check and source-routing-check: no database, no network, no model
 * call, so it belongs in the release gate.
 *
 * WHAT IT PINS DOWN. The batch picks the least recently crawled board first, nullsFirst, and stamps
 * last_crawled_at when it is done with one. The stamp used to sit at the END OF THE TRY, so a board
 * whose index could not be fetched hit `continue` and was never marked read — and being unmarked, it
 * stayed first in the queue and was picked again on the very next tick.
 *
 * Within hours of the unit going live on 2026-09-22 that made it a permanent no-op: SIXTY batches in
 * one day, every one of them oiljobfinder.com, whose index would not open through the browser —
 * read=0, kept=0, the eight boards behind it never touched, and not one posting ever arriving with
 * via='board'. The pipeline was running perfectly and achieving nothing, which is the hardest kind of
 * broken to see: the tick notes said "9 job boards not read today" every five minutes and were
 * telling the truth.
 *
 * So the rule is structural, and read as structure: the stamp lives in a `finally`, because `continue`
 * skips the end of a try but not a finally. Asserting that is asserting the rotation.
 */
import { readFileSync } from 'fs';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const src = readFileSync('src/lib/jobs/job-boards-batch.ts', 'utf8');
/** Comments stripped, so a rule described in prose cannot satisfy a check. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

console.log('--- the queue rotates ---');
check(/\.order\('last_crawled_at',\s*\{[^}]*nullsFirst:\s*true/.test(code),
  'the batch takes the least recently crawled board first', code.match(/\.order\('last_crawled_at'[^)]*\)/)?.[0] ?? 'no order clause found');

const stamps = code.match(/update\(\{\s*last_crawled_at[^)]*\)[^;]*;/g) ?? [];
check(stamps.length === 1, 'and stamps last_crawled_at in exactly one place', `${stamps.length} stamp(s)`);

// The decisive one. A `continue` skips the rest of a try block but never a finally, so the stamp must
// live in the finally or an unreadable board silently blocks every board behind it.
const finallyBlock = code.match(/\}\s*finally\s*\{[\s\S]*?\n {4}\}/)?.[0] ?? '';
check(!!finallyBlock, 'the per-board block has a finally');
const stampInFinally = /last_crawled_at/.test(finallyBlock);
check(stampInFinally, 'and the stamp is INSIDE it, so a `continue` cannot skip it',
  stampInFinally ? '' : finallyBlock ? 'the finally does not stamp — an unreadable board will block every board behind it' : 'there is no finally to look in');

const tryBody = code.slice(code.indexOf('try {'), code.indexOf('} catch'));
check(!/update\(\{\s*last_crawled_at/.test(tryBody),
  'and NOT at the end of the try, which is where it was when the queue jammed');

console.log('\n--- an unreadable index still rotates, and is still reported ---');
check(/index\.status !== 'live'/.test(code), 'an index that is not live short-circuits the board');
check(/problems\.push\(`\$\{src\.url\}: index/.test(code),
  'and says so in the batch report, so a board failing daily is visible rather than silently skipped');

console.log('\n--- a stamp that fails says so ---');
check(/could not be marked as read/.test(src),
  'a failed stamp is reported, not discarded — an unread write here is what jams the queue');

console.log('\n--- the batch is still the tick\'s, not its own chain ---');
check(!/batchesLeft/.test(code) || !/fetch\(u\.toString\(\)/.test(code),
  'it starts no follow-on batch of its own (508 INFINITE_LOOP_DETECTED)');

console.log(failures ? `\nboard rotation: ${failures} FAILED` : '\nboard rotation: all checks passed');
process.exitCode = failures ? 1 : 0;
