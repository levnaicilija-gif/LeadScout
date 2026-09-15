/**
 * Item 23: the certificate register adapters, held to their rules without touching any register. In the release gate.
 *
 *   npx tsx scripts/verify-adapters-check.ts
 *
 * CSWIP and AMPP are read by pure functions (readCswip, readAmpp), fed FIXTURE payloads in the shapes confirmed live on
 * 2026-09-15 — every name and number below is made up and says so. The rules:
 *   - valid only when the answer carries the number asked about; an expired certificate is invalid;
 *   - an answer that cannot be read, or an AMPP number that is not listed, is never a verdict (not_supported);
 *   - a CSWIP candidate with no matching certificate is not_found; several AMPP holders with one surname pick nobody;
 *   - no photograph, date of birth, phone, address or city leaves an adapter;
 *   - AMPP's filter string carries only what a certificate number or a surname can contain.
 * IRATA, WINDA, CISRS and electrical_dk never fetch (the owner's rule: a captcha or a login stays manual), no adapter but
 * FROSIO's credential link opens a browser, and a register that could not answer lands on "pending issuer", not
 * "not on the issuer register".
 */
import fs from 'node:fs';
import { readCswip, cswipNumber, toCswipDob } from '../src/lib/verify/adapters/cswip';
import { readAmpp, amppNumber, amppSurname } from '../src/lib/verify/adapters/ampp';
import { ADAPTERS } from '../src/lib/verify/adapters';
import { stateFor } from '../src/lib/verify/routes';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const at = '2026-09-15T12:00:00.000Z';
const today = '2026-09-15';

(async () => {
  console.log('CSWIP — TWI\'s answer');
  const photo = 'data:image/jpeg;base64,FIXTUREPHOTO';
  const twi = (certs: any[]) => ({ candidateName: 'FIXTURE Candidate', candidateNo: 400123, dateOfBirth: '1980-01-01T00:00:00', dateOfBirthStr: '01/01/1980', photograph: photo, certifcates: certs });
  const inspector = { role: 'Welding Inspector', level: '3.1', certificateNumber: 987654, expiryDate: '2029-03-01T00:00:00', expiryDateStr: '01/03/2029', employerSponsored: 0 };
  const senior = { role: 'Senior Welding Inspector', level: '3.2', certificateNumber: 987655, expiryDate: '2027-06-30T00:00:00', expiryDateStr: '30/06/2027', employerSponsored: 1 };

  const v = readCswip(twi([inspector]), { number: '987654', level: '3.1', dob: '1980-01-01' }, at, today);
  check(v.result === 'valid' && v.validUntil === '2029-03-01' && v.holderOnSource === 'FIXTURE Candidate', 'a listed certificate number is valid to its expiry, with the holder TWI names', `${v.result} ${v.validUntil} ${v.holderOnSource}`);
  check(/valid on 2026-09-15 only/.test(v.notes ?? ''), 'the result carries TWI\'s "valid on <date> only"', v.notes);
  const leaked = JSON.stringify(v);
  check(!leaked.includes('FIXTUREPHOTO') && !leaked.includes('1980'), 'no photograph or date of birth leaves the adapter');
  const exp = readCswip(twi([{ ...inspector, expiryDate: '2020-03-01T00:00:00', expiryDateStr: '01/03/2020' }]), { number: '987654' }, at, today);
  check(exp.result === 'invalid' && exp.validUntil === '2020-03-01', 'an expired certificate is invalid', `${exp.result} ${exp.validUntil}`);
  const other = readCswip(twi([inspector]), { number: '111111' }, at, today);
  check(other.result === 'not_supported', 'an answer that does not carry the number asked about is not a verdict', other.notes);
  const byCandidate = readCswip(twi([inspector, senior]), { number: '400123', level: '3.2' }, at, today);
  check(byCandidate.result === 'valid' && byCandidate.validUntil === '2027-06-30', 'searched by candidate number, the certificate at the printed level is the one judged', `${byCandidate.result} ${byCandidate.validUntil}`);
  const noLevel = readCswip(twi([inspector, senior]), { number: '400123', level: '3.0' }, at, today);
  check(noLevel.result === 'not_found' && (noLevel.certificates?.length ?? 0) === 2, 'a candidate on the register with no certificate at that level is not_found', noLevel.notes);
  check(readCswip(null, { number: '987654' }, at, today).result === 'not_supported' && readCswip({ candidateName: 'x' } as any, { number: '987654' }, at, today).result === 'not_supported', 'an answer without a certificate list is not a verdict');
  check(cswipNumber(' 98-76 54 ') === '987654' && toCswipDob('1980-01-31') === '1980/01/31' && toCswipDob('31/01/1980') === undefined, 'the number is digits only and the date of birth is sent as yyyy/MM/dd');

  console.log('\nAMPP — the public registry');
  const row = (last: string, creds: any[], extra: any = {}) => ({ user_id: 1, first_name: 'Fixture', last_name: last, city: 'FIXTURECITY', postal_code: '00000', state: 'XX', country: 'FIXTURELAND', address1: 'FIXTURE STREET 1', address2: '', contact_phone: '+00 000 FIXTURE', number: 'P-0001', cred_slug: 'AMPP_BCI', credential_type_name: 'Basic Coatings Inspector', credential_id: 'c1', agg_data: { agg_data: creds }, ...extra });
  const cip2 = { name: 'Certified Coating Inspector Level 2', slug: 'AMPP_CIP2', number: '123456', issued_on: '2022-04-04', expiration_date: '2028-07-15', program_category: 'Coatings' };
  const a = readAmpp([row('Fixturesson', [cip2])], { number: '123456', holder: 'Test Fixturesson', level: '2' }, at, today);
  check(a.result === 'valid' && a.validUntil === '2028-07-15' && a.holderOnSource === 'Fixture Fixturesson', 'a listed credential is valid to its expiration date', `${a.result} ${a.validUntil} ${a.holderOnSource}`);
  const aJson = JSON.stringify(a);
  check(!/FIXTURECITY|FIXTURE STREET|\+00 000|FIXTURELAND|00000/.test(aJson), 'no phone, address, postcode, city or country leaves the adapter');
  const none = readAmpp([], { number: '000000', holder: 'Nobody' }, at, today);
  check(none.result === 'not_supported' && /not a verdict/.test(none.notes ?? '') && /opted in/.test(none.notes ?? ''), 'not listed is not a verdict — the registry lists only current holders who opted in', none.notes);
  const lapsed = readAmpp([row('Fixturesson', [{ ...cip2, expiration_date: '2025-01-31' }])], { number: '123456', holder: 'Fixturesson' }, at, today);
  check(lapsed.result === 'invalid', 'a listed credential past its expiration date is invalid', `${lapsed.result} ${lapsed.validUntil}`);
  const two = readAmpp([row('Fixturesson', [cip2]), row('Fixturesson', [{ ...cip2, number: '654321' }])], { holder: 'Fixturesson' }, at, today);
  check(two.result === 'not_supported' && two.holderOnSource === undefined, 'two holders with one surname and no number pick nobody', two.notes);
  const wrongName = readAmpp([row('Otherson', [cip2])], { number: '123456', holder: 'Fixturesson' }, at, today);
  check(wrongName.result === 'not_supported', 'the number under another surname does not confirm this holder', wrongName.notes);
  const accents = readAmpp([row('Jovanović', [cip2])], { number: '123456', holder: 'Marko Jovanovic' }, at, today);
  check(accents.result === 'valid', 'a surname printed without its accents still matches the registry', accents.result);
  const unmatched = readAmpp([row('Fixturesson', [cip2, { ...cip2, name: 'Certified Coating Inspector Level 3', number: '777777' }])], { holder: 'Fixturesson', level: '1' }, at, today);
  check(unmatched.result === 'not_supported' && (unmatched.certificates?.length ?? 0) === 2, 'a listed holder with no credential at the printed level is not a verdict', unmatched.notes);
  check(amppNumber('123 456"; or 1') === '123456or1' && amppSurname("Seán O'Brien-Smith startswith x") === 'x' && amppSurname("Seán O'Brien-Smith") === "O'Brien-Smith", "the registry's filter carries only a number's or a surname's characters", `${amppNumber('123 456"; or 1')} · ${amppSurname("Seán O'Brien-Smith")}`);

  console.log('\nManual schemes never fetch');
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error('a manual adapter must not fetch'); }) as any;
  const reasons: Record<string, RegExp> = { irata: /reCAPTCHA/i, winda: /WINDA profile|no public search/i, cisrs: /captcha/i, electrical_dk: /company|companies/i };
  for (const [body, reason] of Object.entries(reasons)) {
    const r = await ADAPTERS[body].lookup({ number: '3/12345', holder: 'Fixture Person' });
    check(r.result === 'not_supported' && reason.test(r.notes ?? ''), `${body} says why it is checked by hand, and returns no verdict`, r.notes);
  }
  globalThis.fetch = realFetch;
  check(fetched === 0, 'none of them fetched', `${fetched} fetch(es)`);
  const browserUsers = fs.readdirSync('src/lib/verify/adapters').filter((f) => /from '@\/lib\/browser'/.test(fs.readFileSync(`src/lib/verify/adapters/${f}`, 'utf8')));
  check(browserUsers.join(',') === 'frosio.ts', "no adapter but FROSIO's credential link opens a browser", browserUsers.join(', '));
  check(ADAPTERS.ampp.name.startsWith('AMPP — public credential registry') && ADAPTERS.irata.issuerUrl === 'https://techconnect.irata.org/verify/tech', 'AMPP is the registry adapter and IRATA the manual one');

  console.log('\nWhere a check lands');
  check(stateFor('register', 'not_supported') === 'pending_issuer', 'a register that could not answer is pending the issuer, not "not on the issuer register"', stateFor('register', 'not_supported'));
  check(stateFor('register', 'not_found') === 'checked_not_found' && stateFor('register', null) === 'checked_not_found', 'a register that does not hold the certificate is checked_not_found');
  check(stateFor('register', 'valid') === 'verified_register' && stateFor('issuer_email', 'valid') === 'verified_register' && stateFor('issuer_email', 'not_supported') === 'pending_issuer', 'a confirmed certificate is verified on the register whatever the stored route; otherwise the stored route decides');

  console.log(failures === 0 ? '\nverify adapters check: all checks passed' : `\nverify adapters check: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
