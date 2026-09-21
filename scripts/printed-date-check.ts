/**
 * A printed expiry becomes the right date, or no date at all — never a plausible wrong one.
 *
 *   npx tsx scripts/printed-date-check.ts
 *
 * Pure: no database, no network, no model call. In the release gate.
 *
 * The case that started it is the first one below. `verifications.valid_until` is a Postgres `date`
 * and the lookup route handed it `ext.expiry`, the string copied off the document; Postgres then
 * parsed it in MDY. "17 Jan 2028" survived and "03.09.2028" became 2028-03-09 — six months early on a
 * European ISO 9606 welding qualification, on the column every expiry alert reads. One live row in
 * six was wrong, and nothing looked broken.
 *
 * Both arms matter and the REFUSALS matter more. A parser that reads everything is how the wrong
 * date got there; the failure this could introduce is an expiry that is confidently wrong, which in
 * item 8 marks a welder unavailable for the work their certificate qualifies them for.
 */
import { printedDate } from '../src/lib/printed-date';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const reads = (raw: string, expected: string) => {
  const r = printedDate(raw);
  check(r.date === expected, `"${raw}" reads as ${expected}`, r.date === expected ? '' : `got ${r.date ?? 'null'} — ${r.why}`);
};
const refuses = (raw: string, because: string) => {
  const r = printedDate(raw);
  check(r.date === null, `"${raw}" is refused (${because})`, r.date ? `STORED ${r.date} instead` : '');
  check(!!r.why, `  and says why`, r.why.slice(0, 90));
};

console.log('--- the live row this was written for ---');
// documents.extracted.expiry on an ISO 9606 certificate; Postgres stored 2028-03-09.
reads('03.09.2028', '2028-09-03');
reads('17 Jan 2028', '2028-01-17');
reads('18.06.2027', '2027-06-18');

console.log('\n--- a named month cannot be misread, in either order ---');
reads('17 January 2028', '2028-01-17');
reads('Jan 17, 2028', '2028-01-17');
reads('5 Sep 2030', '2030-09-05');

console.log('\n--- already a date ---');
reads('2028-01-17', '2028-01-17');
reads('2028-01-17T00:00:00Z', '2028-01-17');

console.log('\n--- numeric, where the text forces one reading ---');
reads('25/12/2027', '2027-12-25');   // 25 can only be the day
reads('12/25/2027', '2027-12-25');   // 25 can only be the day, the other way round
reads('31-03-2029', '2029-03-31');

console.log('\n--- numeric, where it does NOT: refused, not guessed ---');
refuses('05/06/2028', 'British 5 June, American 6 May, and AMPP is American');
refuses('01-02-2030', 'same ambiguity with dashes');

console.log('\n--- not a real day, however it is written ---');
refuses('31.02.2028', '31 February is not a day');
refuses('2028-02-31', 'nor is it as ISO');
refuses('17.13.2028', 'there is no thirteenth month');

console.log('\n--- nothing to read ---');
refuses('', 'nothing printed');
refuses('see reverse', 'not a date at all');
refuses('17.01.28', 'a two-digit year is not worth a guess on this column');

console.log('\n--- the dot rule is deliberate and narrow ---');
const dotted = printedDate('03.09.2028');
check(/day first/.test(dotted.why), 'a dotted numeric date says why it was read day first', dotted.why);
const slashed = printedDate('03/09/2028');
check(slashed.date === null && /ambiguous/.test(slashed.why), 'the same digits with slashes are refused instead', `${slashed.date ?? 'null'} — ${slashed.why.slice(0, 60)}`);

console.log(failures ? `\nprinted date: ${failures} FAILED` : '\nprinted date: all checks passed');
process.exit(failures ? 1 : 0);
