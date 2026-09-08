import { chromium } from 'playwright';
import { appearsIn } from '@/lib/ai/claude';
import type { Adapter, LookupInput, LookupResult } from './types';

/**
 * IRATA rope access — Technician Verification Tool.
 *
 * Confirmed against the live site on 2026-09-08:
 *   Entry   https://irata.org/verify/ links to the tool on IRATA TechConnect.
 *   Form    https://techconnect.irata.org/verify/tech  (public, no login — the rest of
 *           techconnect.irata.org redirects to /login, this page does not)
 *   Fields  #last_name ("Last Name *"), #irataid ("IRATA No. *"), submit button "Search"
 *   Note    IRATA numbers print as L/XXXXX where L is the level (1, 2 or 3); the tool wants
 *           the number, so we strip a leading "<level>/" and keep the level for cross-check.
 *   Per IRATA's own guidance the tool returns the technician's level and expiry date, and
 *   covers expired/on-hold technicians as well as current ones.
 *
 * The RESULT MARKUP IS NOT YET CONFIRMED — that needs a real IRATA number and surname.
 * Until then this reads the whole results area as text and will only report `valid` when the
 * surname actually appears on the page together with a date. Record the real selectors here
 * on the first real certificate (build order step 1).
 */
const ENTRY_URL = 'https://irata.org/verify/';
const FORM_URL = 'https://techconnect.irata.org/verify/tech';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const lastName = (holder?: string) => (holder ?? '').trim().split(/\s+/).filter(Boolean).pop();
/** "3/12345" -> { id: "12345", level: "3" }; a bare number stays as-is. */
function splitIrataNumber(n?: string) {
  const m = (n ?? '').trim().match(/^([123])\s*\/\s*(\d+)$/);
  if (m) return { id: m[2], level: m[1] };
  return { id: (n ?? '').trim().replace(/^\D+/, ''), level: undefined as string | undefined };
}

function parseDate(s: string): string | undefined {
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const uk = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (uk) return `${uk[3]}-${uk[2].padStart(2, '0')}-${uk[1].padStart(2, '0')}`;
  const long = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})\b/);
  if (long) {
    const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(long[2].slice(0, 3).toLowerCase());
    if (mi >= 0) return `${long[3]}-${String(mi + 1).padStart(2, '0')}-${long[1].padStart(2, '0')}`;
  }
  return undefined;
}

export const irata: Adapter = {
  body: 'irata',
  name: 'IRATA — Technician Verification (techconnect.irata.org)',
  issuerUrl: ENTRY_URL,
  supports: (i) => !!splitIrataNumber(i.number).id && !!lastName(i.holder),

  async lookup(i: LookupInput): Promise<LookupResult> {
    const checkedAt = new Date().toISOString();
    const { id, level } = splitIrataNumber(i.number);
    const surname = lastName(i.holder);
    if (!id || !surname) {
      return { result: 'not_supported', checkedWhere: ENTRY_URL, checkedAt, notes: 'IRATA verification needs both the IRATA number (L/XXXXX) and the technician surname' };
    }

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ userAgent: UA });
      page.setDefaultTimeout(45000);
      await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f; };' });
      await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('#irataid', { timeout: 30000 });
      await page.fill('#last_name', surname);
      await page.fill('#irataid', id);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
        page.click('button[type=submit]'),
      ]);
      await page.waitForTimeout(3500);

      const text = await page.evaluate(() => document.body.innerText);
      const screenshot = await page.screenshot({ fullPage: true });
      const base = { checkedWhere: page.url(), checkedAt, screenshot };

      // The honesty check: the surname must actually appear in the result.
      if (!appearsIn(text, surname) || /no (results?|records?|technician|match)/i.test(text)) {
        return { ...base, result: 'not_found', notes: `IRATA has no technician ${id} with surname "${surname}"` };
      }

      const expiryLine = text.split('\n').find((l) => /expir|valid until/i.test(l));
      const validUntil = expiryLine ? parseDate(expiryLine) : undefined;
      const onHold = /on hold|suspend/i.test(text);
      const today = new Date().toISOString().slice(0, 10);
      const expired = onHold || (!!validUntil && validUntil < today);
      const levelOnSource = text.match(/level\s*:?\s*([123])/i)?.[1];

      return {
        ...base,
        result: expired ? 'invalid' : 'valid',
        validUntil,
        holderOnSource: surname,
        notes: [
          levelOnSource ? `level ${levelOnSource} on source` : undefined,
          level && levelOnSource && level !== levelOnSource ? `certificate says level ${level}` : undefined,
          onHold ? 'certification on hold / suspended' : undefined,
          validUntil ? undefined : 'no expiry date found on the results page',
        ].filter(Boolean).join(' · '),
      };
    } finally {
      await browser.close();
    }
  },
};
