import { chromium, type Browser } from 'playwright';

export type Fetched = {
  url: string;
  status: 'live' | 'not_found';
  title: string;
  text: string;
  /** Absolute hrefs of every anchor on the page, deduped. Read from the DOM, not from the text. */
  links: string[];
  screenshot: Buffer | null;
  fetchedAt: string;
};

/**
 * Fetch a page with a real browser: visible text, the anchor hrefs, and a screenshot.
 *
 * Browserbase is required anywhere without a local browser. Vercel's serverless runtime has
 * no Playwright download, so falling back to chromium.launch() there fails with a confusing
 * "Executable doesn't exist" per source; fail with the real reason instead.
 */
async function connect(): Promise<Browser> {
  const key = process.env.BROWSERBASE_API_KEY;
  if (key) return chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${key}`);
  if (process.env.VERCEL) {
    throw new Error('BROWSERBASE_API_KEY is not set. Vercel has no local browser, so Radar cannot fetch pages without it.');
  }
  return chromium.launch();
}

export async function fetchPage(url: string): Promise<Fetched> {
  const browser = await connect();
  const miss = (): Fetched => ({ url, status: 'not_found', title: '', text: '', links: [], screenshot: null, fetchedAt: new Date().toISOString() });
  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    });
    // tsx/esbuild compiles page functions with --keep-names, which calls a __name helper that
    // does not exist in the browser. Provide it; passed as a string so it is not rewritten.
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f; };' });
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!res || res.status() >= 400) return miss();
    await page.waitForTimeout(1200);
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText);
    const links: string[] = await page.evaluate(() =>
      Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href))),
    );
    const screenshot = await page.screenshot({ fullPage: false });
    return { url, status: 'live', title, text, links, screenshot, fetchedAt: new Date().toISOString() };
  } catch {
    return miss();
  } finally {
    await browser.close();
  }
}

/** Paths that are never an article: navigation, taxonomy, accounts, assets, feeds. */
const NOT_ARTICLE = /\/(tag|tags|category|categories|topic|topics|author|authors|page|pages|search|advanced-search|login|signin|register|account|subscribe|newsletter|privacy|terms|cookies?|contact|about|sitemap|feed|rss|careers?|jobs|vacancies|investors?|products?|services|team|people|events|webinars?|advertise|wp-json|wp-admin|wp-content|cdn-cgi)(\/|$)/i;
const ASSET = /\.(png|jpe?g|gif|svg|webp|avif|css|js|json|xml|pdf|zip|mp4|mp3|ico|woff2?)$/i;

/**
 * Article-ish links from an index page: same host, not the index itself, not navigation or
 * an asset, and shaped like a story rather than a section — either a date in the path or a
 * headline slug of four or more words. Section pages ("/company-news") and nav entries
 * ("/careers/why-drax") are two or three words and get dropped.
 *
 * This is still a heuristic. Per-source rules in sources.crawl_prompt (or an RSS feed where
 * one exists) are the real answer and are the next thing to add.
 */
export function articleLinks(index: Fetched, limit = 15): string[] {
  let origin: string;
  try { origin = new URL(index.url).origin; } catch { return []; }
  const self = index.url.replace(/\/$/, '');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of index.links) {
    let u: URL;
    try { u = new URL(raw); } catch { continue; }
    if (u.origin !== origin) continue;
    u.hash = '';
    u.search = '';
    const href = u.toString().replace(/\/$/, '');
    if (href === self || seen.has(href)) continue;
    const path = u.pathname;
    if (ASSET.test(path) || NOT_ARTICLE.test(path)) continue;
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    const last = segments[segments.length - 1];
    if (!/[a-z]{3}/i.test(last)) continue;
    const words = last.split(/[-_]/).filter((w) => /[a-z]{2}/i.test(w)).length;
    const dated = /\/(19|20)\d{2}\//.test(path);
    if (!dated && words < 4) continue;
    seen.add(href);
    out.push(href);
    if (out.length >= limit) break;
  }
  return out;
}
