import { chromium } from 'playwright';
import type { Adapter } from './types';
/** FROSIO certificates are issued via Accredible; FROSIO's site has a certificate search. Selectors WILL need adjusting on first run — record the real ones here. */
export const frosio: Adapter = {
  body: 'frosio', name: 'FROSIO (frosio.no / Accredible)',
  supports: (i) => !!i.number || !!i.holder,
  async lookup(i) {
    const url = `https://www.frosio.no/certified-personnel/?search=${encodeURIComponent(i.number ?? i.holder ?? '')}`;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText);
      const screenshot = await page.screenshot();
      const checkedAt = new Date().toISOString();
      const hit = i.number && text.includes(i.number);
      const m = text.match(/(valid|expir\w*)[^0-9]{0,20}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
      if (!hit) return { result: 'not_found', checkedWhere: url, checkedAt, screenshot, notes: 'Number not present on results page' };
      return { result: 'valid', checkedWhere: url, checkedAt, validUntil: m?.[2], screenshot, holderOnSource: i.holder && text.toLowerCase().includes(i.holder.toLowerCase()) ? i.holder : undefined };
    } finally { await browser.close(); }
  },
};
