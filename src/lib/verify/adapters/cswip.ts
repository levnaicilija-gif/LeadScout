import { chromium } from 'playwright';
import type { Adapter, LookupInput, LookupResult } from './types';

/**
 * CSWIP / BGAS-CSWIP — TWI Certification Ltd.
 *
 * Confirmed against the live site on 2026-09-08:
 *   Page      https://www.cswip.com/verification  (canonical of /microsites/cswip/verification)
 *   Fields    #CandidateNumber ("Candidate or Certificate number"), #DateOfBirth (DD/MM/YYYY,
 *             a date-picker that rewrites whatever is typed), submit is a#submitCert.
 *   Gotcha    a Civic cookie banner (#ccc) overlays the form and swallows the click until
 *             #ccc-recommended-settings is pressed.
 *   Real call the page posts JSON to
 *               POST https://www.cswip.com/api/CSWIPVerificationAPIController/VerifyCertificate
 *               {"certificateNo":"<number>","dob":"yyyy/MM/dd"}
 *             so we call that endpoint directly and use the page only for the screenshot.
 *
 * TWO THINGS ARE NOT YET CONFIRMED, because that needs a real CSWIP certificate:
 *   - the success payload's field names (we therefore only accept a response that actually
 *     contains the certificate number, and only report an expiry we can find in it);
 *   - whether "no such certificate" is the HTTP 500 we saw for a bogus number, or a 200 with
 *     an empty body. We treat 500 as not_found only when the response carries no data.
 * Record both here on the first real certificate (build order step 1).
 *
 * CSWIP is keyed on date of birth, which most certificates do not print. Without a DOB this
 * adapter cannot search at all, and says so rather than guessing.
 */
const PAGE_URL = 'https://www.cswip.com/verification';
const API_URL = 'https://www.cswip.com/api/CSWIPVerificationAPIController/VerifyCertificate';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

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
    const dob = toApiDob(i.dob);
    if (!i.number) {
      return { result: 'not_supported', checkedWhere: PAGE_URL, checkedAt, notes: 'CSWIP needs the candidate or certificate number printed on the certificate' };
    }
    if (!dob) {
      return {
        result: 'not_supported', checkedWhere: PAGE_URL, checkedAt,
        notes: "CSWIP verifies on certificate number + date of birth. Add the candidate's date of birth (from the passport on file) and re-check; or verify by hand at cswip.com/verification.",
      };
    }

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ userAgent: UA });
      page.setDefaultTimeout(45000);
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);
      // The cookie banner overlays the form; dismiss it so the screenshot shows the page.
      const cookie = await page.$('#ccc-recommended-settings');
      if (cookie) await cookie.click().catch(() => {});
      await page.waitForTimeout(800);

      const res = await page.evaluate(
        async ([url, certificateNo, d]) => {
          const r = await fetch(url as string, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ certificateNo, dob: d }),
          });
          let body: string = '';
          try { body = await r.text(); } catch { /* empty */ }
          return { status: r.status, body };
        },
        [API_URL, i.number, dob] as const,
      );

      const screenshot = await page.screenshot({ fullPage: true });
      const base = { checkedWhere: PAGE_URL, checkedAt, screenshot };

      let payload: unknown = null;
      try { payload = res.body ? JSON.parse(res.body) : null; } catch { payload = null; }
      const hasData = !!payload && !(Array.isArray(payload) && payload.length === 0) && res.body.trim() !== 'null';

      if (!hasData) {
        return { ...base, result: 'not_found', notes: `CSWIP returned HTTP ${res.status} with no certificate data for ${i.number}` };
      }

      // The honesty check: the payload must actually carry the number we asked about.
      const flat = JSON.stringify(payload).toLowerCase();
      if (!flat.includes(i.number.toLowerCase())) {
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
    } finally {
      await browser.close();
    }
  },
};
