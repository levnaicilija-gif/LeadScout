import { chromium } from 'playwright';
export type Fetched = { url: string; status: 'live' | 'not_found'; title: string; text: string; screenshot: Buffer | null; fetchedAt: string };
/** Fetch a page with a real browser, return visible text + screenshot. 90 s budget. */
export async function fetchPage(url: string): Promise<Fetched> {
  const browser = process.env.BROWSERBASE_API_KEY
    ? await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${process.env.BROWSERBASE_API_KEY}`)
    : await chromium.launch();
  try {
    const page = await browser.newPage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!res || res.status() >= 400) return { url, status: 'not_found', title: '', text: '', screenshot: null, fetchedAt: new Date().toISOString() };
    await page.waitForTimeout(1200);
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText);
    const screenshot = await page.screenshot({ fullPage: false });
    return { url, status: 'live', title, text, screenshot, fetchedAt: new Date().toISOString() };
  } finally { await browser.close(); }
}
