/**
 * Received, verified, missing and expired — per document TYPE, because they are not the same states.
 *
 *   npx tsx scripts/campaign-docs-check.ts
 *
 * Pure: no database, no network, no model call. In the release gate.
 *
 * What this pins down is the decision that a uniform three-state model would have got wrong. Only a
 * certificate has a register behind it (item 23), so only a certificate can be "verified"; a passport
 * has nothing to check against and "received" is its ceiling. Investigated before building: the
 * lookup route keys entirely on ext.cert_body and writes 'unsupported' to anything without one, and
 * the "name and expiry cross-check" the queue item cites is holderFits — a name-fit gate at ATTACH
 * time, which verifies nothing about a document's contents.
 *
 * Both arms, and the refusals matter more: a passport that came back "verified" would be a fabricated
 * assurance about somebody's right to work, which is the one thing this codebase never does.
 */
import { docStatus, docStatuses, packReady, isVerifiable, label } from '../src/lib/campaign-docs';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const NOW = new Date('2026-09-21T12:00:00Z');
const doc = (id: string, type: string, cert_state?: string | null) => ({ id, type, cert_state: cert_state ?? null });
const ver = (document_id: string, state: string | null, valid_until: string | null) => ({ document_id, state, valid_until });

console.log('--- a certificate is the only type with a register behind it ---');
check(isVerifiable('certificate'), 'certificate is verifiable');
for (const t of ['passport', 'medical', 'a1', 'contract', 'test_report', 'other']) {
  check(!isVerifiable(t), `${t} is not`);
}

console.log('\n--- missing ---');
const missing = docStatus('passport', [], [], NOW);
check(missing.state === 'missing', 'no file at all reads missing', missing.why);
check(missing.why.length > 0, 'and says so in words');

console.log('\n--- received, where received is the ceiling ---');
const pp = docStatus('passport', [doc('d1', 'passport')], [], NOW);
check(pp.state === 'received', 'a passport on file reads received', pp.why);
check(pp.verifiable === false, 'and is marked unverifiable, so the screen can say why');
check(/no register/i.test(pp.why), 'and the reason names the absence of a register, not a failure', pp.why);
check(pp.expiresOn === null, 'and carries no expiry, because none is trustworthy for this type');

console.log('\n--- a certificate moves through all four ---');
const held = docStatus('certificate', [doc('c1', 'certificate')], [], NOW);
check(held.state === 'received', 'held but never checked reads received', held.why);
check(/not checked/i.test(held.why), 'and says it has not been to the issuer', held.why);

const pending = docStatus('certificate', [doc('c1', 'certificate', 'pending_issuer')], [ver('c1', 'pending_issuer', '2030-01-01')], NOW);
check(pending.state === 'received', 'pending with the issuer is still only received', pending.why);

const confirmed = docStatus('certificate', [doc('c1', 'certificate', 'verified_register')], [ver('c1', 'verified_register', '2030-01-01')], NOW);
check(confirmed.state === 'verified', 'confirmed on the register reads verified', confirmed.why);
check(confirmed.expiresOn === '2030-01-01', 'and carries its valid_until', String(confirmed.expiresOn));

const expired = docStatus('certificate', [doc('c1', 'certificate', 'verified_register')], [ver('c1', 'verified_register', '2026-09-20')], NOW);
check(expired.state === 'expired', 'one day past valid_until reads expired', expired.why);
check(/expired on 2026-09-20/.test(expired.why), 'and names the date it went', expired.why);
const edge = docStatus('certificate', [doc('c1', 'certificate', 'verified_register')], [ver('c1', 'verified_register', '2026-09-21')], NOW);
check(edge.state === 'verified', 'the last valid day is still valid, not expired', edge.why);

console.log('\n--- several certificates: the best one decides ---');
const mixed = docStatus('certificate',
  [doc('c1', 'certificate', 'verified_register'), doc('c2', 'certificate', 'verified_register')],
  [ver('c1', 'verified_register', '2026-09-01'), ver('c2', 'verified_register', '2027-05-05')], NOW);
check(mixed.state === 'verified' && mixed.expiresOn === '2027-05-05',
  'an expired certificate does not cancel a valid one', `${mixed.state}, to ${mixed.expiresOn}`);
const bothGone = docStatus('certificate',
  [doc('c1', 'certificate', 'verified_register'), doc('c2', 'certificate', 'verified_register')],
  [ver('c1', 'verified_register', '2026-09-01'), ver('c2', 'verified_register', '2026-01-01')], NOW);
check(bothGone.state === 'expired', 'but when everything held has expired, that is what it says', bothGone.why);
const longest = docStatus('certificate',
  [doc('c1', 'certificate', 'verified_register'), doc('c2', 'certificate', 'verified_register')],
  [ver('c1', 'verified_register', '2027-01-01'), ver('c2', 'verified_register', '2029-01-01')], NOW);
check(longest.expiresOn === '2029-01-01', 'and the cover that runs longest is the one reported', String(longest.expiresOn));

console.log('\n--- a printed expiry is never treated as a date ---');
// documents.extracted.expiry is free text as printed ("03.09.2028"); only verifications.valid_until
// is a real date. Reading the printed text here is the fault fixed in dab0828.
const printedOnly = docStatus('certificate', [{ id: 'c1', type: 'certificate', cert_state: 'verified_register', extracted: { expiry: '03.09.2028' } }], [], NOW);
check(printedOnly.expiresOn === null, 'a certificate with only printed text carries no expiry date', String(printedOnly.expiresOn));
check(printedOnly.state === 'verified', 'and is still verified — no date is not the same as expired', printedOnly.why);

console.log('\n--- ready to send ---');
const required = ['passport', 'certificate'];
const allGood = docStatuses(required, [doc('p', 'passport'), doc('c1', 'certificate', 'verified_register')], [ver('c1', 'verified_register', '2030-01-01')], NOW);
const r1 = packReady(allGood);
check(r1.ready, 'verified where it can be, received where it cannot, is ready', JSON.stringify(r1.blockers));

const noPassport = packReady(docStatuses(required, [doc('c1', 'certificate', 'verified_register')], [ver('c1', 'verified_register', '2030-01-01')], NOW));
check(!noPassport.ready && /passport missing/.test(noPassport.blockers.join('; ')), 'a missing passport blocks it, by name', noPassport.blockers.join('; '));

const unconfirmed = packReady(docStatuses(required, [doc('p', 'passport'), doc('c1', 'certificate')], [], NOW));
check(!unconfirmed.ready && /not confirmed with the issuer/.test(unconfirmed.blockers.join('; ')),
  'a certificate on file but never checked blocks it', unconfirmed.blockers.join('; '));

const expiredBlocks = packReady(docStatuses(required, [doc('p', 'passport'), doc('c1', 'certificate', 'verified_register')], [ver('c1', 'verified_register', '2026-01-01')], NOW));
check(!expiredBlocks.ready && /expired on 2026-01-01/.test(expiredBlocks.blockers.join('; ')),
  'an expired certificate blocks it and says when it went', expiredBlocks.blockers.join('; '));

// The decisive one: a received-only type must never be treated as an unmet requirement, or every
// campaign requiring a passport would be permanently unsendable.
const passportOnly = packReady(docStatuses(['passport'], [doc('p', 'passport')], [], NOW));
check(passportOnly.ready, 'a received-only type does not block a pack for lacking a verified state', JSON.stringify(passportOnly.blockers));

console.log('\n--- the words a recruiter uses ---');
check(label('a1') === 'A1', 'a1 reads as A1');
check(label('test_report') === 'test report', 'test_report reads as test report');

console.log(failures ? `\ncampaign docs: ${failures} FAILED` : '\ncampaign docs: all checks passed');
process.exitCode = failures ? 1 : 0;
