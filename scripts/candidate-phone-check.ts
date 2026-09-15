/**
 * Item 24: a candidate's phone and email are checked for shape only, before they are stored — no lookup anywhere.
 * In the release gate; no network.
 *
 *   npx tsx scripts/candidate-phone-check.ts
 */
import { checkPhone, checkEmail } from '../src/lib/phone';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const show = (r: any) => (r.ok ? `ok: ${JSON.stringify(r.value)}` : `refused: ${r.error}`);

(async () => {
  for (const good of ['+47 912 34 567', '0047 91234567', '+381 (64) 123-4567', '+44 7700.900.123', '912 34 567', '+45/22 33 44 55']) {
    const r = checkPhone(good);
    check(r.ok && r.value === good.replace(/\s+/g, ' '), `"${good}" is a phone number, kept as typed`, show(r));
  }
  check(checkPhone('  +47  912   34 567 ').ok && (checkPhone('  +47  912   34 567 ') as any).value === '+47 912 34 567', 'extra spaces are tidied, nothing else changes');
  const blank = checkPhone('');
  check(blank.ok && blank.value === null, 'an empty phone clears the field', show(blank));
  for (const [bad, why] of [
    ['call me', /only digits/], ['+47 912 34 56x', /only digits/], ['47+91234567', /\+ can only come first/], ['++47 91234567', /\+ can only come first/],
    ['1234567', /7 digits is too short/], ['2023-25', /6 digits is too short/], ['+47 (912 34 567', /brackets do not match/], ['1234567890123456', /16 digits is too long/],
  ] as [string, RegExp][]) {
    const r = checkPhone(bad);
    check(!r.ok && why.test((r as any).error), `"${bad}" is refused with the reason`, show(r));
  }
  check(checkEmail('marko.j@example.com').ok && !checkEmail('marko.j@').ok && !checkEmail('marko j@example.com').ok && (checkEmail('') as any).value === null, 'an email is checked for shape; empty clears it');

  console.log(failures === 0 ? '\ncandidate phone check: all checks passed' : `\ncandidate phone check: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
