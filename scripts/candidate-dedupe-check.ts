/**
 * Item 24: does a dropped CV ask before creating a likely duplicate — by the WindEurope rule, name plus a second field?
 * In the release gate; no network.
 *
 *   npx tsx scripts/candidate-dedupe-check.ts
 */
import { judgeDuplicate, type CandidateIdentity } from '../src/lib/candidate-dedupe';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

const pool: CandidateIdentity[] = [
  { id: 'a', reference_code: 'RFBT-P-0004', full_name: 'Marko Jovanović', email: 'marko.j@example.com', phone: '+381 64 123 4567', dob: '1984-03-02' },
  { id: 'b', reference_code: 'RFBT-F-0009', full_name: 'Ana Popescu', email: null, phone: null, dob: null },
  { id: 'c', reference_code: 'RFBT-W-0012', full_name: 'Lars Nilsen', email: 'lars@example.no', phone: '+47 912 34 567', dob: null },
  { id: 'd', reference_code: 'RFBT-W-0013', full_name: 'Marian Marcu', email: 'mmarcu@example.ro', phone: null, dob: null },
];
const show = (j: any) => j.verdict === 'ask' ? `ask: ${j.matches.map((m: any) => `${m.candidate.reference_code} ${m.strength} (${m.why})`).join(' | ')}` : `create: ${j.why}`;

(async () => {
  const sameEmail = judgeDuplicate(pool, { full_name: 'JOVANOVIC Marko', email: 'Marko.J@example.com' });
  check(sameEmail.verdict === 'ask' && sameEmail.matches[0].candidate.id === 'a' && sameEmail.matches[0].strength === 'likely', 'same name (surname first, no accent) and the same email: ask, as likely', show(sameEmail));
  const samePhone = judgeDuplicate(pool, { full_name: 'Lars Nilsen', phone: '0047 91234567' });
  check(samePhone.verdict === 'ask' && samePhone.matches[0].strength === 'likely' && /phone/.test(samePhone.matches[0].why), 'the same phone written differently still agrees', show(samePhone));
  const differ = judgeDuplicate(pool, { full_name: 'Lars Nilsen', email: 'lars.nilsen@other.dk', phone: '+45 22 33 44 55' });
  check(differ.verdict === 'create' && differ.namesakes.length === 1 && /different person/.test(differ.why), 'the same name with a different email and phone is a different person: create, and say so', show(differ));
  const nameOnly = judgeDuplicate(pool, { full_name: 'Ana Popescu', email: 'ana@example.ro' });
  check(nameOnly.verdict === 'ask' && nameOnly.matches[0].strength === 'name_only' && /name only/.test(nameOnly.matches[0].why), 'the same name with nothing on file to compare: ask, and say it is the name only', show(nameOnly));
  const initial = judgeDuplicate(pool, { full_name: 'M. Marcu', email: 'mmarcu@example.ro' });
  check(initial.verdict === 'ask' && initial.matches[0].candidate.id === 'd' && initial.matches[0].strength === 'likely', 'an initial for the first name plus the same email: ask, as likely', show(initial));
  const initialNothing = judgeDuplicate(pool, { full_name: 'M. Marcu', email: 'someone.else@example.com' });
  check(initialNothing.verdict === 'create', 'a near name with nothing agreeing is not asked about', show(initialNothing));
  const nobody = judgeDuplicate(pool, { full_name: 'Piotr Kowalski', email: 'marko.j@example.com' });
  check(nobody.verdict === 'create', 'a shared email under a different name is not a name match: create', show(nobody));
  const sameDob = judgeDuplicate(pool, { full_name: 'Marko Jovanovic', dob: '1984-03-02', email: 'new@example.com' });
  check(sameDob.verdict === 'ask' && /date of birth/.test(sameDob.matches[0].why) && sameDob.matches[0].strength === 'likely', 'date of birth agreeing is enough even when the email changed', show(sameDob));
  const noName = judgeDuplicate(pool, { full_name: '', email: 'marko.j@example.com' });
  check(noName.verdict === 'create' && /no name/.test(noName.why), 'a CV with no name is not matched on its email alone', show(noName));
  const shortDigits = judgeDuplicate(pool, { full_name: 'Lars Nilsen', phone: '2023-2025' });
  check(shortDigits.verdict === 'ask' && shortDigits.matches[0].strength === 'name_only', 'fewer than nine digits is not a phone number to compare', show(shortDigits));

  console.log(failures === 0 ? '\ncandidate dedupe check: all checks passed' : `\ncandidate dedupe check: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
