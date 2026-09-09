import { httpPost } from '@/lib/http';
import type { Adapter, LookupInput, LookupResult } from './types';

/**
 * CSWIP / BGAS-CSWIP — TWI Certification Ltd. NO BROWSER NEEDED.
 *
 * Confirmed against the live site on 2026-09-08, moved to plain HTTP 2026-09-09:
 *   Page  https://www.cswip.com/verification  (#CandidateNumber + #DateOfBirth, a#submitCert,
 *         with a Civic cookie banner overlaying the form — irrelevant now that we skip the page)
 *   API   the page posts JSON to
 *           POST https://www.cswip.com/api/CSWIPVerificationAPIController/VerifyCertificate
 *           {"certificateNo":"<number>","dob":"yyyy/MM/dd"}
 *         and that endpoint answers a plain request with the same status as it does the
 *         browser's, so no browser is involved.
 *
 * NOT YET CONFIRMED, because it needs a real CSWIP certificate:
 *   - the success payload's field names — so we accept a response only if it actually contains
 *     the certificate number, and report only an expiry we can find in it;
 *   - whether "no such certificate" is always the HTTP 500 seen for a bogus number. 500 with no
 *     body is treated as not_found; a 500 carrying data would be reported as unrecognised.
 * Record both here on the first real certificate.
 *
 * CSWIP is keyed on date of birth, which most certificates do not print; without one this
 * adapter says so rather than guessing.
 */
const PAGE_URL = 'https://www.cswip.com/verification';
const API_URL = 'https://www.cswip.com/api/CSWIPVerificationAPIController/VerifyCertificate';

/** yyyy-mm-dd -> yyyy/MM/dd, the only format the endpoint accepts. */
const toApiDob = (dob?: string) => {
  const m = (dob ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : undefined;
};

/** Pull a yyyy-mm-dd out of whatever the payload calls the expiry field. */
function findExpiry(o: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (v: unknown, key = ''): string | undefined => {
    if (v == null || seen.has(v)) return undefined;
    if (typeof v === 'string') {
      if (!/expir|valid|until/i.test(key)) return undefined;
      const iso = v.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return iso[0];
      const uk = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (uk) return `${uk[3]}-${uk[2].padStart(2, '0')}-${uk[1].padStart(2, '0')}`;
      return undefined;
    }
    if (typeof v !== 'object') return undefined;
    seen.add(v);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const hit = walk(val, k);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(o);
}

export const cswip: Adapter = {
  body: 'cswip',
  name: 'CSWIP / BGAS-CSWIP — TWI Certification (cswip.com)',
  issuerUrl: PAGE_URL,
  supports: () => true, // always answers; explains itself when it cannot search

  async lookup(i: LookupInput): Promise<LookupResult> {
    const checkedAt = new Date().toISOString();
    const base = { checkedWhere: PAGE_URL, checkedAt };
    const dob = toApiDob(i.dob);
    if (!i.number) return { ...base, result: 'not_supported', notes: 'CSWIP needs the candidate or certificate number printed on the certificate' };
    if (!dob) {
      return { ...base, result: 'not_supported', notes: "CSWIP verifies on certificate number + date of birth. Add the candidate's date of birth (from the passport on file) and re-check; or verify by hand at cswip.com/verification." };
    }

    const res = await httpPost(API_URL, JSON.stringify({ certificateNo: i.number, dob }), {
      'content-type': 'application/json',
      origin: 'https://www.cswip.com',
      referer: PAGE_URL,
    });
    if (res.status === 0) return { ...base, result: 'not_supported', notes: `CSWIP did not respond (${res.error})` };

    let payload: unknown = null;
    try { payload = res.body ? JSON.parse(res.body) : null; } catch { payload = null; }
    const hasData = !!payload && !(Array.isArray(payload) && payload.length === 0) && res.body.trim() !== 'null';

    if (!hasData) return { ...base, result: 'not_found', notes: `CSWIP returned HTTP ${res.status} with no certificate data for ${i.number}` };

    // The honesty check: the payload must actually carry the number we asked about.
    if (!JSON.stringify(payload).toLowerCase().includes(i.number.toLowerCase())) {
      return { ...base, result: 'not_supported', notes: `CSWIP responded (HTTP ${res.status}) but the payload does not contain ${i.number}; record the real response shape in cswip.ts` };
    }

    const validUntil = findExpiry(payload);
    const today = new Date().toISOString().slice(0, 10);
    const expired = !!validUntil && validUntil < today;
    return {
      ...base,
      result: expired ? 'invalid' : 'valid',
      validUntil,
      notes: validUntil ? `CSWIP confirmed ${i.number}${expired ? `, expired ${validUntil}` : ''}` : `CSWIP confirmed ${i.number}; no expiry date in the response`,
    };
  },
};
