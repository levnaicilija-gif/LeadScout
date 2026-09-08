import { chromium } from 'playwright';
import type { Adapter } from './types';
/** BINDT PCN certificate holder search. */
export const pcn: Adapter = {
  body: 'pcn', name: 'PCN — BINDT (bindt.org)',
  supports: (i) => !!i.number,
  async lookup(i) {
    const url = 'https://www.bindt.org/Certification/PCN/pcn-certificate-holder-search/';
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const input = page.locator('input[type="text"]').first();
      await input.fill(i.number!);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2500);
      const text = await page.evaluate(() => document.body.innerText);
      const screenshot = await page.screenshot();
      const checkedAt = new Date().toISOString();
      if (!text.includes(i.number!)) return { result: 'not_found', checkedWhere: url, checkedAt, screenshot };
      const m = text.match(/(expir\w*|valid until)[^0-9]{0,20}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
      return { result: 'valid', checkedWhere: url, checkedAt, validUntil: m?.[2], screenshot };
    } finally { await browser.close(); }
  },
};
