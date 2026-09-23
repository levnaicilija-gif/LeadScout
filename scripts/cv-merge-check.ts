/**
 * A newer CV updates a record without overwriting what a recruiter typed.
 *
 *   npx tsx scripts/cv-merge-check.ts
 *
 * Pure: no database, no network, no model call. In the release gate.
 *
 * The three tiers are the whole rule, and the middle one is where the damage would be: a re-parsed
 * CV putting back the phone number somebody corrected by hand is silent, plausible and permanent.
 * So the fixture below has a record whose phone was corrected, whose trade was refined, and whose
 * notes and availability are a recruiter's own — and the CV disagrees with every one of them.
 */
import { mergeFromCv, mergeNote, FILLABLE, NEVER_FROM_CV } from '../src/lib/cv-merge';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

/** A record a recruiter has worked on: phone corrected, trade refined, notes and availability theirs. */
const CURRENT = {
  trade: 'Coating inspector',
  languages: ['Romanian', 'English'],
  phone: '+40 721 000 111',
  email: null,
  nationality: 'RO',
  internal_notes: 'Rang 12 Sep — wants Norway only, not UK.',
  availability_from: '2026-11-01',
  stage: 'screening',
  owner_id: 'user-a',
  data_retention_until: '2027-01-01',
};

/** The new CV: a better reading in places, an out-of-date phone, and an email the record lacks. */
const PROFILE = {
  trade: 'Painter / blaster',
  languages: ['Romanian', 'English', 'Italian'],
  nationality: 'RO',
  pii: { phone: '+40 700 999 888', email: 'm.marcu@example.ro' },
  projects: [{ years: '2021-2024', type: 'offshore painting' }],
};

console.log('--- ALWAYS: the reading of the newest CV ---');
const m = mergeFromCv(CURRENT, PROFILE);
check(m.patch.profile === PROFILE, 'the parsed profile is always written — the newest CV is the current one');

console.log('\n--- FILL BLANKS: what the record did not have ---');
check(m.patch.email === 'm.marcu@example.ro', 'an email the record lacked is taken from the CV', String(m.patch.email));
check(m.filled.includes('email'), 'and is reported as filled in', m.filled.join(', '));

console.log('\n--- NEVER OVERWRITE: what the recruiter already had ---');
check(!('phone' in m.patch), 'a phone the recruiter corrected is NOT overwritten by an older one on the CV');
check(!('trade' in m.patch), 'nor a trade they refined');
check(!('languages' in m.patch), 'nor languages they already recorded');
const fields = m.conflicts.map((c) => c.field).sort();
check(JSON.stringify(fields) === JSON.stringify(['languages', 'phone', 'trade']), 'each disagreement is reported instead', fields.join(', '));
const phone = m.conflicts.find((c) => c.field === 'phone');
check(phone?.current === '+40 721 000 111' && phone?.fromCv === '+40 700 999 888', 'and carries both values, so a recruiter can choose', `${phone?.current} vs ${phone?.fromCv}`);

console.log('\n--- NEVER FROM A CV: a person\'s judgement about a person ---');
for (const f of NEVER_FROM_CV) check(!(f in m.patch), `${f} is never written from a CV`);
check(Object.keys(m.patch).every((k) => k === 'profile' || (FILLABLE as readonly string[]).includes(k)),
  'the patch contains nothing but the profile and fillable fields', Object.keys(m.patch).join(', '));

console.log('\n--- a CV that says nothing never blanks a stored value ---');
const silent = mergeFromCv(CURRENT, { pii: {} });
check(!('trade' in silent.patch) && !('phone' in silent.patch), 'no field is emptied because the CV omitted it', Object.keys(silent.patch).join(', '));
check(silent.conflicts.length === 0, 'and silence is not a disagreement');

console.log('\n--- an empty record takes everything the CV states ---');
const empty = mergeFromCv({ trade: null, languages: [], phone: '', email: null, nationality: null }, PROFILE);
check(empty.filled.sort().join(',') === 'email,languages,nationality,phone,trade', 'every stated field is filled', empty.filled.join(', '));
check(empty.conflicts.length === 0, 'with nothing to disagree with');

console.log('\n--- the same value in different words is not a conflict ---');
const tidy = mergeFromCv({ trade: ' welder ', languages: ['English', 'Romanian'] }, { trade: 'Welder', languages: ['romanian', 'english'], pii: {} });
check(tidy.conflicts.length === 0, 'case, spacing and order do not make a disagreement', JSON.stringify(tidy.conflicts));
check(!('trade' in tidy.patch), 'and nothing is rewritten to restyle it');

console.log('\n--- an OLDER CV attached later changes nothing (item 24 step 9) ---');
const older = mergeFromCv(CURRENT, PROFILE, { isNewest: false });
check(Object.keys(older.patch).length === 0, 'not even the profile', JSON.stringify(older.patch));
check(older.conflicts.length === 0 && older.filled.length === 0, 'and it reports nothing to decide');

console.log('\n--- the line a recruiter reads ---');
check(/filled in email/.test(mergeNote(m) ?? ''), 'says what it filled in', mergeNote(m) ?? '');
check(/nothing was overwritten/.test(mergeNote(m) ?? ''), 'and says plainly that nothing was overwritten');
check(mergeNote(mergeFromCv({ trade: 'Welder' }, { trade: 'Welder', pii: {} })) === null, 'and says nothing when there is nothing to say');

console.log(failures ? `\ncv merge: ${failures} FAILED` : '\ncv merge: all checks passed');
process.exitCode = failures ? 1 : 0;
