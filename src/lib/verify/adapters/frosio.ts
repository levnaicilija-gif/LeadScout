import { chromium } from 'playwright';
import { appearsIn } from '@/lib/ai/claude';
import type { Adapter, LookupInput, LookupResult } from './types';

/**
 * FROSIO — surface treatment / insulation inspectors.
 *
 * Checked against the live sites on 2026-09-08:
 *   frosio.no          no public certificate register. The whole site was crawled:
 *                      the only certificate-related pages are marketing, renewal
 *                      instructions and the course calendar. The previously assumed
 *                      /certified-personnel/?search= path does not exist (it redirects
 *                      to /en/).
 *   apps.frosio.no     "FROSIO Portal" — login only (inspector / company officer /
 *                      administration). No public search.
 *   credential.net     FROSIO issues digital certificates through Accredible. Accredible
 *                      has NO public search by name or number (/search returns "We can't
 *                      seem to find what you're looking for") and api.accredible.com
 *                      requires an issuer API token (401). A credential is only reachable
 *                      through the unique URL / QR code printed on the certificate itself.
 *
 * So there are exactly two honest outcomes:
 *   1. The certificate carries an Accredible credential URL (or QR) -> fetch that page,
 *      screenshot it, and report only what is actually printed on it.
 *   2. Otherwise -> not_supported, and Verify falls back to the issuer-email path with
 *      frosio@frosio.no. We never claim a FROSIO certificate is valid without a page.
 *
 * NOTE: the credential.net parsing below is deliberately label/text based rather than
 * CSS-selector based, and it can only ever return `valid` when the holder or the
 * certificate number is literally present on the fetched page. It has NOT yet been
 * confirmed against a real FROSIO credential — do that on the first real certificate
 * (build order step 1) and record the confirmed labels here.
 */
const ISSUER_URL = 'https://frosio.no/en/';
export const FROSIO_ISSUER_EMAIL = 'frosio@frosio.no';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const isCredentialUrl = (u?: string) => !!u && /^https?:\/\/(www\.)?(credential\.net|.*\.credential\.net|api\.accredible\.com)\//i.test(u.trim());

/** Dates as Accredible prints them, e.g. "14 March 2028" or "2028-03-14". Returns undefined rather than guessing. */
function parseDate(s?: string): string | undefined {
  if (!s) return undefined;
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const long = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})\b/);
  if (long) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mi = months.indexOf(long[2].slice(0, 3).toLowerCase());
    if (mi >= 0) return `${long[3]}-${String(mi + 1).padStart(2, '0')}-${long[1].padStart(2, '0')}`;
  }
  return undefined;
}

export const frosio: Adapter = {
  body: 'frosio',
  name: 'FROSIO (frosio.no — no public register; Accredible credential URL only)',
  issuerUrl: ISSUER_URL,
  // Always handled here: only the credential URL can be checked, and when there is none
  // the adapter itself explains why and where to go instead.
  supports: () => true,

  async lookup(i: LookupInput): Promise<LookupResult> {
    const checkedAt = new Date().toISOString();
    if (!isCredentialUrl(i.credentialUrl)) {
      return {
        result: 'not_supported',
        checkedWhere: ISSUER_URL,
        checkedAt,
        notes: `FROSIO has no public certificate register (frosio.no has no search; the FROSIO Portal is login-only; Accredible has no public search). Verify by the credential URL/QR printed on the certificate, or ask ${FROSIO_ISSUER_EMAIL} to confirm.`,
      };
    }

    const url = i.credentialUrl!.trim();
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ userAgent: UA });
      page.setDefaultTimeout(45000);
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      const text = await page.evaluate(() => document.body.innerText);
      const screenshot = await page.screenshot({ fullPage: true });
      const checkedWhere = page.url();

      if (!resp || resp.status() >= 400) {
        return { result: 'not_found', checkedWhere, checkedAt, screenshot, notes: `Credential page returned HTTP ${resp?.status() ?? 'no response'}` };
      }

      // The honesty check: the page must actually carry the holder or the certificate number.
      const hasHolder = !!i.holder && appearsIn(text, i.holder);
      const hasNumber = !!i.number && appearsIn(text, i.number);
      if (!hasHolder && !hasNumber) {
        return {
          result: 'not_found', checkedWhere, checkedAt, screenshot,
          notes: 'Credential page loaded but neither the holder name nor the certificate number appears on it',
        };
      }

      const expiryLabel = text.match(/(expir\w*|valid until|valid through)[^\n]{0,40}/i)?.[0];
      const validUntil = parseDate(expiryLabel);
      const revoked = /\b(revoked|expired|no longer valid)\b/i.test(text);
      const today = new Date().toISOString().slice(0, 10);
      const expired = revoked || (!!validUntil && validUntil < today);

      return {
        result: expired ? 'invalid' : 'valid',
        checkedWhere, checkedAt, screenshot, validUntil,
        holderOnSource: hasHolder ? i.holder : undefined,
        notes: [
          hasNumber ? `certificate number found on page` : undefined,
          hasHolder ? `holder name found on page` : undefined,
          validUntil ? undefined : 'no expiry date printed on the credential page',
          revoked ? 'page states the credential is revoked/expired' : undefined,
        ].filter(Boolean).join(' · '),
      };
    } finally {
      await browser.close();
    }
  },
};
