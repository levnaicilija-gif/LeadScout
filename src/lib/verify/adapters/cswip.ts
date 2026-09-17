import { httpPost } from '@/lib/http';
import type { Adapter, LookupInput, LookupResult, SourceCertificate } from './types';
import { ukDateToIso } from './types';

/**
 * CSWIP / BGAS-CSWIP — TWI Certification Ltd. NO BROWSER, NO LOGIN, NO CAPTCHA.
 *
 * Confirmed against the live site on 2026-09-08, and again on 2026-09-15 (item 23) from TWI's own page code:
 *   Page   https://www.cswip.com/verification — #CandidateNumber ("Candidate or Certificate number", digits) and
 *          #DateOfBirth (DD/MM/YYYY); a#submitCert. The page loads reCAPTCHA's script, but this form has no widget and its
 *          handler (/microsites/cswip/js/cswip.js, `$('#submitCert').click`) sends no token.
 *   API    POST https://www.cswip.com/api/CSWIPVerificationAPIController/VerifyCertificate
 *          {"certificateNo":"<number>","dob":"yyyy/MM/dd"}, JSON.
 *   Answer the handler's success branch reads candidateName, candidateNo, dateOfBirth, dateOfBirthStr, photograph and
 *          certifcates[] (TWI's spelling) with role, level, certificateNumber, expiryDate, expiryDateStr and
 *          employerSponsored, and prints "This verification is valid on <date> only".
 *   Errors the handler's error branch shows one message for every failure — "If you experience any problem with
 *          verification of a certificate please contact us at verification@twi.co.uk" — and a made-up number answers
 *          HTTP 500 with no body. An error therefore cannot tell an unknown number from a fault on TWI's side, and is
 *          never reported as "not found": it goes to TWI by email.
 *
 * The photograph and the date of birth are never kept. CSWIP is keyed on date of birth, which most certificates do not
 * print; the lookup route takes it from the passport on file, and without one this says so.
 * Not yet seen with a real CSWIP certificate (none on file on 2026-09-15): the success shape is TWI's own page code.
 */
const PAGE_URL = 'https://www.cswip.com/verification';
const API_URL = 'https://www.cswip.com/api/CSWIPVerificationAPIController/VerifyCertificate';

/** yyyy-mm-dd -> yyyy/MM/dd, the only format the endpoint accepts. */
export const toCswipDob = (dob?: string) => {
  const m = (dob ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : undefined;
};
/** The form accepts digits only ("Please enter a valid candidate or certificate number"). */
export const cswipNumber = (s?: string) => (s ?? '').replace(/\D/g, '');

const isoOf = (iso?: unknown, printed?: unknown) =>
  (typeof iso === 'string' ? iso.match(/^\d{4}-\d{2}-\d{2}/)?.[0] : undefined) ?? ukDateToIso(typeof printed === 'string' ? printed : undefined) ?? (typeof printed === 'string' && printed.trim() ? printed.trim() : undefined);

type CswipCert = { role?: string; level?: string | null; certificateNumber?: string | number | null; expiryDate?: string | null; expiryDateStr?: string | null; employerSponsored?: number };
type CswipPayload = { candidateName?: string; candidateNo?: string | number; certifcates?: CswipCert[] };

/** Read TWI's answer for one certificate. Pure, so scripts/verify-adapters-check.ts holds it to the rules. */
export function readCswip(payload: CswipPayload | null, input: LookupInput, checkedAt: string, today = new Date().toISOString().slice(0, 10)): LookupResult {
  const base = { checkedWhere: PAGE_URL, checkedAt };
  const want = cswipNumber(input.number);
  const certs = Array.isArray(payload?.certifcates) ? payload!.certifcates! : null;
  if (!payload || !certs) {
    return { ...base, result: 'not_supported', notes: 'TWI answered without a candidate and certificate list — the API may have changed; record the new shape in cswip.ts. Not a verdict.' };
  }

  const certificates: SourceCertificate[] = certs.map((c) => ({
    number: c.certificateNumber != null ? String(c.certificateNumber) : undefined,
    method: c.role ?? undefined,
    level: c.level ?? undefined,
    expiry: isoOf(c.expiryDate, c.expiryDateStr),
  }));
  const candidateNo = payload.candidateNo != null ? String(payload.candidateNo) : '';
  // The honesty check: the answer must carry the number that was asked about, as the candidate or a certificate number.
  const byCertificate = certificates.find((c) => cswipNumber(c.number) === want);
  if (!byCertificate && cswipNumber(candidateNo) !== want) {
    return { ...base, result: 'not_supported', notes: `TWI answered, but neither the candidate number nor any certificate number is ${want} — not a verdict.` };
  }

  const holderOnSource = payload.candidateName?.trim() || undefined;
  const level = String(input.level ?? '').replace(/^level\s*/i, '').trim();
  const match = byCertificate
    ?? (level ? certificates.find((c) => (c.level ?? '').replace(/^level\s*/i, '').trim() === level || (c.method ?? '').includes(level)) : undefined)
    ?? (certificates.length === 1 ? certificates[0] : undefined);
  const listed = certificates.map((c) => `${c.method ?? '?'}${c.level ? ` level ${c.level}` : ''} — ${c.number ?? 'no number'} expires ${c.expiry ?? '?'}`).join(' · ');
  const summary = `CSWIP candidate ${candidateNo || '?'} · ${certificates.length} certificate(s) · ${listed} · TWI: this verification is valid on ${today} only`;

  if (!match) {
    return { ...base, result: 'not_found', holderOnSource, certificates, notes: `The candidate is on TWI's register, but no certificate there matches ${input.level ? `level ${input.level}` : 'this certificate'}. ${summary}` };
  }
  const expired = !!match.expiry && /^\d{4}-\d{2}-\d{2}$/.test(match.expiry) && match.expiry < today;
  return {
    ...base, result: expired ? 'invalid' : 'valid', holderOnSource, certificates,
    validUntil: /^\d{4}-\d{2}-\d{2}$/.test(match.expiry ?? '') ? match.expiry : undefined,
    notes: `${expired ? `Expired ${match.expiry}. ` : ''}${summary}`,
  };
}

export const cswip: Adapter = {
  body: 'cswip',
  searchable: true,
  name: 'CSWIP / BGAS-CSWIP — TWI Certification (cswip.com)',
  issuerUrl: PAGE_URL,
  supports: () => true, // always answers; explains itself when it cannot search

  async lookup(i: LookupInput): Promise<LookupResult> {
    const checkedAt = new Date().toISOString();
    const base = { checkedWhere: PAGE_URL, checkedAt };
    const number = cswipNumber(i.number);
    const dob = toCswipDob(i.dob);
    if (!number) return { ...base, result: 'not_supported', notes: 'CSWIP needs the candidate or certificate number printed on the certificate.' };
    if (!dob) return { ...base, result: 'not_supported', notes: "CSWIP verifies on the number and the holder's date of birth. Upload the passport, or check by hand at cswip.com/verification." };

    const res = await httpPost(API_URL, JSON.stringify({ certificateNo: number, dob }), {
      'content-type': 'application/json; charset=utf-8', accept: 'application/json', origin: 'https://www.cswip.com', referer: PAGE_URL,
    });
    if (!res.ok) {
      return { ...base, result: 'not_supported', notes: `TWI answered ${res.error ?? `HTTP ${res.status}`}. Its own page shows the same message for an unknown number and date of birth as for a fault on its side, so this is not a verdict — confirm at cswip.com/verification or with verification@twi.co.uk.` };
    }
    let payload: CswipPayload | null = null;
    try { payload = JSON.parse(res.body); } catch { payload = null; }
    return readCswip(payload, i, checkedAt);
  },
};
