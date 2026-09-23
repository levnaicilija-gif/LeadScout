/**
 * A record standing on a certificate alone says so — and stops saying so by itself.
 *
 *   npx tsx scripts/certificate-only-check.ts
 *
 * Pure: no database, no network, no model call. In the release gate.
 *
 * The rule is deliberately the ABSENCE OF A CV rather than the presence of a certificate, and it is
 * computed on read rather than stored. Both choices are asserted here, because both are the kind of
 * thing a later change quietly gets wrong: a stored flag needs clearing by whoever attaches the CV,
 * and the one that is missed leaves a full candidate reading "certificate-only" in front of a client.
 */
import { isCertificateOnly, certificateOnlyBadge, CERTIFICATE_ONLY_LABEL } from '../src/lib/certificate-only';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

console.log('--- what makes a record certificate-only ---');
check(isCertificateOnly([{ type: 'certificate' }]), 'a certificate and nothing else');
check(isCertificateOnly([{ type: 'certificate' }, { type: 'certificate' }]), 'several certificates are still no CV');
check(isCertificateOnly([{ type: 'medical' }]), 'a medical alone is the same position — the test is the missing CV, not the kind of ticket');
check(isCertificateOnly([{ type: 'passport' }]), 'and so is a passport alone');

console.log('\n--- and what does not ---');
check(!isCertificateOnly([{ type: 'cv' }]), 'a CV on file makes it an ordinary record');
check(!isCertificateOnly([{ type: 'certificate' }, { type: 'cv' }]), 'a CV plus certificates is ordinary, however many certificates there are');
check(!isCertificateOnly([]), 'a record with no documents at all is NOT labelled — it was typed by somebody, not opened from a ticket');
check(!isCertificateOnly(null), 'and neither is one whose documents could not be read', 'null');
check(!isCertificateOnly(undefined), 'nor one that was never given any', 'undefined');

console.log('\n--- it stops being true by itself, which is why it is not stored ---');
const docs: { type: string }[] = [{ type: 'certificate' }];
check(isCertificateOnly(docs), 'certificate-only while that is all there is');
docs.push({ type: 'cv' });
check(!isCertificateOnly(docs), 'and no longer, the moment a CV is attached — nothing has to remember to clear a flag');

console.log('\n--- case and shape are not load-bearing ---');
check(!isCertificateOnly([{ type: 'CV' }]), 'the CV type is matched whatever its case');
check(isCertificateOnly([{ type: null }]), 'a document with no type recorded is not mistaken for a CV');
check(isCertificateOnly([{} as any]), 'and neither is a row with no type at all');

console.log('\n--- the badge says what it is and what is missing ---');
const badge = certificateOnlyBadge([{ type: 'certificate' }]);
check(badge?.label === CERTIFICATE_ONLY_LABEL, 'the label is the one constant every screen uses', badge?.label);
check(/no cv on file/i.test(badge?.note ?? ''), 'and the note says plainly there is no CV', badge?.note?.slice(0, 60));
check(/history|availability/i.test(badge?.note ?? ''), 'and what that means nobody knows');
check(certificateOnlyBadge([{ type: 'cv' }]) === null, 'an ordinary record gets no badge at all');

console.log(failures ? `\ncertificate only: ${failures} FAILED` : '\ncertificate only: all checks passed');
process.exitCode = failures ? 1 : 0;
