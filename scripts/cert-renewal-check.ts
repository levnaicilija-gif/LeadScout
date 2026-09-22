/**
 * 60 / 30 / 7, measured against the one date that can be trusted — and a renewal that is really drafted.
 *
 *   npx tsx scripts/cert-renewal-check.ts
 *
 * Pure: no database, no network, no model call. In the release gate.
 *
 * Today has carried an expiring-certificate item since item 8's first pass, and its sub-line read
 * "Renewal message drafted". NOTHING DRAFTED ONE — the only occurrence of the word "renewal" in src/
 * was that string. A line telling a recruiter that work has been done for them, where none had, is
 * the same fault as a verified state with no register behind it.
 *
 * The thresholds measure against verifications.valid_until and nothing else. documents.extracted.expiry
 * is the text as PRINTED and is not a date: handing it to Postgres is what stored a European
 * 03.09.2028 as 9 March, six months early, until dab0828.
 */
import { thresholdFor, daysTo, renewalDraft, validityNote, THRESHOLDS } from '../src/lib/cert-renewal';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const NOW = new Date('2026-09-22T12:00:00Z');
const inDays = (n: number) => new Date(Date.UTC(2026, 8, 22) + n * 86400000).toISOString().slice(0, 10);

console.log('--- the thresholds, and the tightest one wins ---');
check(THRESHOLDS.join(',') === '7,30,60', 'the thresholds are 7, 30 and 60', THRESHOLDS.join(','));
check(thresholdFor(inDays(90), NOW) === null, '90 days out raises nothing');
check(thresholdFor(inDays(61), NOW) === null, '61 days out raises nothing — the boundary is 60, not "about 60"');
check(thresholdFor(inDays(60), NOW) === 60, '60 days out is the 60-day alert');
check(thresholdFor(inDays(31), NOW) === 60, '31 days out is still the 60-day alert');
check(thresholdFor(inDays(30), NOW) === 30, '30 days out moves to the 30-day alert');
check(thresholdFor(inDays(8), NOW) === 30, '8 days out is still the 30-day alert');
check(thresholdFor(inDays(7), NOW) === 7, '7 days out moves to the 7-day alert');
check(thresholdFor(inDays(1), NOW) === 7, 'and one day out is the same alert, not a fourth one');
check(thresholdFor(inDays(0), NOW) === 7, 'expiring today has not expired yet');
check(thresholdFor(inDays(-1), NOW) === 'expired', 'yesterday is expired');
check(thresholdFor(null, NOW) === null, 'no date raises nothing at all — silence beats a guessed alert');
check(thresholdFor(undefined, NOW) === null, 'and neither does a missing one');

console.log('\n--- the day count is whole days, not hours ---');
check(daysTo(inDays(7), NOW) === 7, 'seven days is seven', String(daysTo(inDays(7), NOW)));
check(daysTo(inDays(0), NOW) === 0, 'today is zero', String(daysTo(inDays(0), NOW)));
check(daysTo(inDays(-3), NOW) === -3, 'and gone is negative', String(daysTo(inDays(-3), NOW)));

console.log('\n--- the draft is real, and says the things a recruiter would have to type ---');
const soon = renewalDraft({ candidateName: 'Marian M', reference: 'RFBT-W-0004', certBody: 'frosio', level: '3', number: '10810', validUntil: inDays(20), agency: 'RFBT Recruitment', now: NOW });
check(/frosio/i.test(soon.subject) || /FROSIO/.test(soon.subject), 'the subject names the certificate', soon.subject);
check(/12 October 2026/.test(soon.subject), 'and the date it goes, written out', soon.subject);
check(/Marian M/.test(soon.body), 'the body greets the person by name');
check(/10810/.test(soon.body), 'and quotes the certificate number');
check(/20 days from now/.test(soon.body), 'and says how long is left', soon.body.match(/expires on[^.]*/)?.[0] ?? '');
check(/RFBT Recruitment/.test(soon.body), 'and signs off as the agency');
check(!/unsubscribe|click here/i.test(soon.body), 'and reads like a person wrote it');

console.log('\n--- expired reads differently, because it is a different conversation ---');
const gone = renewalDraft({ candidateName: 'Marian M', certBody: 'cswip', validUntil: inDays(-10), agency: 'RFBT Recruitment', now: NOW });
check(/has expired/i.test(gone.subject), 'the subject says it has gone', gone.subject);
check(/cannot put you forward/i.test(gone.body), 'and the body says what that means for them', gone.body.split('\n').find((l) => /cannot/i.test(l))?.slice(0, 80) ?? '');
check(/sends people home/i.test(gone.body), 'in the terms that actually matter on a site');
check(!/expires on/.test(gone.body), 'and does not talk about a future expiry that has already happened');

console.log('\n--- it will not invent a renewal route it does not know ---');
// FROSIO is in the certificate library with a validity note; a made-up body is not.
const known = validityNote('frosio', '3');
check(typeof known === 'string' && known.length > 0, 'a body the library knows contributes its own words', String(known));
check(validityNote('not_a_real_body') === null, 'a body it does not know contributes nothing');
const unknown = renewalDraft({ candidateName: 'A', certBody: 'not_a_real_body', validUntil: inDays(20), agency: 'RFBT', now: NOW });
check(/we will find out with the issuing body/i.test(unknown.body),
  'so the draft ASKS rather than stating a process that may not exist', unknown.body.split('\n').find((l) => /find out/i.test(l)) ?? '');
check(!/3 years|5 years|recertification/i.test(unknown.body), 'and never borrows another body\'s terms');
check(/library records no renewal terms/.test(unknown.basis), 'and the basis says why it asked', unknown.basis);

const withTerms = renewalDraft({ candidateName: 'A', certBody: 'frosio', level: '3', validUntil: inDays(20), agency: 'RFBT', now: NOW });
check(withTerms.body.includes(String(known)), 'where the library does know, the issuer\'s own words are quoted', String(known).slice(0, 60));
check(/certificate library/.test(withTerms.basis), 'and the basis names where they came from', withTerms.basis);

console.log('\n--- nothing here sends anything ---');
check(!/send button|mailto:|api\/outreach/i.test(soon.body + soon.subject), 'the draft is text, not a send action');

console.log(failures ? `\ncert renewal: ${failures} FAILED` : '\ncert renewal: all checks passed');
process.exitCode = failures ? 1 : 0;
