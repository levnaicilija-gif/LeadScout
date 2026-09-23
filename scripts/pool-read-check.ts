/**
 * A failed read of the candidate pool never looks like an empty pool.
 *
 *   npx tsx scripts/pool-read-check.ts
 *
 * No network and no real database — the client is a stub, so every case here is exact.
 *
 * WHY THIS EXISTS. On 2026-09-22 the same CV was dropped twice and became two candidate records,
 * RFBT-P-0625 and RFBT-P-0626, with no warning shown. The duplicate rule was fine; it was asked a
 * question about an empty pool. Verify's intake read the candidates with
 * `const { data: existing } = await allRows(...)` and never looked at `{ error }`, so a read that
 * failed produced `known = []` — and judgeDuplicate, working perfectly, found nobody to compare
 * against. Reproduced by mutation: with the read forced to fail, two drops make two records and ask
 * nothing; with it working, the second drop creates nothing and offers the match.
 *
 * The rule the fix encodes: AN ABSENCE YOU DID NOT VERIFY IS NOT AN ABSENCE. The pool read either
 * answers in full or refuses, and a PARTIAL read is a refusal too — allRows returns the pages it
 * managed ALONG WITH the error, which is right for a list that shows what it can and wrong for
 * "is this person already on file", because the page that failed is exactly where the duplicate
 * would have been.
 */
import { readPoolForMatching, POOL_UNREADABLE } from '../src/lib/candidate-pool-read';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const ROW = (id: string, name: string) => ({
  id, reference_code: `RFBT-P-${id}`, full_name: name, email: null, phone: null,
  profile: { pii: { dob: '1987-06-02' } }, availability_from: null,
});

/** A stub that answers each page in turn: a row array, or an error. */
function stubDb(pages: ({ data: any[] } | { error: { message: string } })[]) {
  let call = 0;
  const answer = () => {
    const page = pages[Math.min(call++, pages.length - 1)];
    return 'error' in page ? { data: null, error: page.error } : { data: page.data, error: null };
  };
  const chain: any = {
    select: () => chain, eq: () => chain, order: () => chain,
    range: () => Promise.resolve(answer()),
  };
  return { from: () => chain } as any;
}

(async () => {
  console.log('--- a read that works ---');
  const ok = await readPoolForMatching(stubDb([{ data: [ROW('0625', 'M. Marcu')] }]), 'ws');
  check(ok.error === null, 'reports no error');
  check(ok.known.length === 1, 'and returns the pool', `${ok.known.length}`);
  check(ok.known[0].key === 'marcu m' || ok.known[0].key === 'm marcu', 'with the name normalised for matching', ok.known[0].key);
  check(ok.known[0].dob === '1987-06-02', 'and the date of birth lifted out of the profile so it can be compared', String(ok.known[0].dob));

  console.log('\n--- a read that FAILS outright ---');
  const bad = await readPoolForMatching(stubDb([{ error: { message: 'connect timeout' } }]), 'ws');
  check(bad.error === 'connect timeout', 'reports the error rather than swallowing it', String(bad.error));
  check(bad.known.length === 0, 'and returns no rows');
  check(bad.error !== null, 'THE POINT: the caller can tell "could not look" from "nobody matched"');

  console.log('\n--- a read that fails HALFWAY, which is the subtle one ---');
  // A full page, then a failure: allRows has real rows in hand and an error beside them.
  const partial = await readPoolForMatching(
    stubDb([{ data: Array.from({ length: 1000 }, (_, i) => ROW(String(i), `Person ${i}`)) }, { error: { message: 'connect timeout on page 2' } }]),
    'ws',
  );
  check(partial.error !== null, 'a partial read is reported as an error, not as a shorter pool', String(partial.error));
  check(partial.known.length === 0, 'and hands back NOTHING, so no caller can match against half the pool', `${partial.known.length} rows`);

  console.log('\n--- what the recruiter is told ---');
  check(/could not be read/i.test(POOL_UNREADABLE), 'the message says the list could not be read');
  check(/nothing has been created or changed/i.test(POOL_UNREADABLE), 'and that nothing was created or changed');
  check(!/no match|not found|nobody/i.test(POOL_UNREADABLE), 'and never claims nobody matched', POOL_UNREADABLE);

  console.log('\n--- an empty workspace is still an honest empty ---');
  const empty = await readPoolForMatching(stubDb([{ data: [] }]), 'ws');
  check(empty.error === null && empty.known.length === 0, 'a real empty pool reports no error and no rows — the one case that MAY create');

  console.log(failures ? `\npool read: ${failures} FAILED` : '\npool read: all checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
