import * as cheerio from 'cheerio';
import { httpGet } from './http';
import { connectBrowser, NoBrowserError } from './browser';

export type Fetched = {
  url: string;
  status: 'live' | 'not_found';
  title: string;
  text: string;
  /** Absolute hrefs found on the page, deduped. */
  links: string[];
  screenshot: Buffer | null;
  fetchedAt: string;
  /** How it was read, so a source audit can say which sources cost money. */
  via: 'http' | 'rss' | 'browser' | 'none';
  note?: string;
};

const miss = (url: string, note: string, via: Fetched['via'] = 'none'): Fetched => ({
  url, status: 'not_found', title: '', text: '', links: [], screenshot: null, fetchedAt: new Date().toISOString(), via, note,
});

/** Visible text from HTML, without a browser: drop script/style/nav chrome, collapse space. */
function readable($: cheerio.CheerioAPI): string {
  $('script, style, noscript, svg, iframe').remove();
  return $('body').text().replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*/g, '\n').trim();
}

/** RSS/Atom item links. Feeds are the cheapest and cleanest source of article URLs. */
function parseFeed(xml: string): { title: string; links: string[] } {
  const $ = cheerio.load(xml, { xmlMode: true });
  const links: string[] = [];
  $('item > link, entry > link').each((_, el) => {
    const href = $(el).attr('href') ?? $(el).text();
    if (href && href.trim()) links.push(href.trim());
  });
  return { title: $('channel > title, feed > title').first().text().trim(), links: [...new Set(links)] };
}

const isFeed = (contentType: string, body: string) =>
  /xml|rss|atom/i.test(contentType) || /^\s*<\?xml|<rss[\s>]|<feed[\s>]/i.test(body.slice(0, 400));

/** A page we clearly failed to read: JS shell, bot wall, or nothing much at all. */
function needsBrowser(html: string, text: string, links: number): string | null {
  if (/just a moment|checking your browser|enable javascript|cf-browser-verification/i.test(html)) return 'bot/JS wall';
  if (text.length < 400 && links < 5) return `only ${text.length} chars and ${links} links — looks JavaScript-rendered`;
  return null;
}

/**
 * Read a page as cheaply as possible.
 *
 *   1. plain HTTP (free, runs anywhere). If the URL is a feed, parse it as one.
 *   2. if the source advertises an RSS feed and the HTML gave us nothing useful, take the feed.
 *   3. only then a browser, and only if one is configured.
 *
 * `via` records which path answered, so a source audit can report what actually needs a browser.
 */
export async function fetchPage(url: string, opts: { allowBrowser?: boolean; force?: 'browser' } = {}): Promise<Fetched> {
  const allowBrowser = opts.allowBrowser ?? true;
  // Some sites are known to be client-rendered — skip the pointless plain fetch.
  if (opts.force === 'browser') return allowBrowser ? viaBrowser(url, 'source rule says this host is client-rendered') : miss(url, 'source rule requires a browser', 'none');
  const now = () => new Date().toISOString();

  const res = await httpGet(url);
  if (res.status === 0) return allowBrowser ? viaBrowser(url, `plain fetch failed: ${res.error}`) : miss(url, `plain fetch failed: ${res.error}`);

  if (res.ok && isFeed(res.contentType, res.body)) {
    const feed = parseFeed(res.body);
    return { url, status: 'live', title: feed.title, text: res.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), links: feed.links, screenshot: null, fetchedAt: now(), via: 'rss' };
  }

  if (res.ok) {
    const $ = cheerio.load(res.body);
    const title = $('title').first().text().trim();
    const text = readable($);
    const links = [...new Set($('a[href]').map((_, a) => {
      try { return new URL($(a).attr('href')!, res.url).toString(); } catch { return ''; }
    }).get().filter(Boolean))];

    const problem = needsBrowser(res.body, text, links.length);
    if (!problem) return { url, status: 'live', title, text, links, screenshot: null, fetchedAt: now(), via: 'http' };

    // The page itself was thin — try its advertised feed before paying for a browser.
    const feedHref = $('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]').first().attr('href');
    if (feedHref) {
      try {
        const feedUrl = new URL(feedHref, res.url).toString();
        const f = await httpGet(feedUrl);
        if (f.ok && isFeed(f.contentType, f.body)) {
          const feed = parseFeed(f.body);
          if (feed.links.length) return { url, status: 'live', title: title || feed.title, text, links: feed.links, screenshot: null, fetchedAt: now(), via: 'rss', note: `page needed JS; used its feed ${feedUrl}` };
        }
      } catch { /* fall through to the browser */ }
    }
    return allowBrowser ? viaBrowser(url, problem) : miss(url, problem, 'http');
  }

  const why = `HTTP ${res.status}`;
  if (res.status === 403 || res.status === 429) return allowBrowser ? viaBrowser(url, why) : miss(url, why, 'http');
  return miss(url, why, 'http');
}

async function viaBrowser(url: string, why: string): Promise<Fetched> {
  let browser;
  try {
    browser = await connectBrowser();
  } catch (e: any) {
    if (e instanceof NoBrowserError) return miss(url, `needs a browser (${why}) and none is configured`, 'none');
    return miss(url, `browser connect failed: ${String(e?.message ?? e).split('\n')[0]}`, 'none');
  }
  try {
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36' });
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f; };' });
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!res || res.status() >= 400) return miss(url, `browser got HTTP ${res?.status() ?? 'no response'}`, 'browser');
    await page.waitForTimeout(1200);
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText);
    const links: string[] = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href))));
    const screenshot = await page.screenshot({ fullPage: false });
    return { url, status: 'live', title, text, links, screenshot, fetchedAt: new Date().toISOString(), via: 'browser', note: `plain fetch insufficient: ${why}` };
  } catch (e: any) {
    return miss(url, `browser failed: ${String(e?.message ?? e).split('\n')[0]}`, 'browser');
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
 * headline slug of four or more words.
 *
 * RSS item links skip the shape test: a feed only carries articles, so trust it.
 */
export function articleLinks(index: Fetched, limit = 15, pattern?: RegExp): string[] {
  let origin: string;
  try { origin = new URL(index.url).origin; } catch { return []; }
  const self = index.url.replace(/\/$/, '');
  const fromFeed = index.via === 'rss';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of index.links) {
    let u: URL;
    try { u = new URL(raw); } catch { continue; }
    if (u.origin !== origin) continue;
    u.hash = '';
    if (!fromFeed) u.search = '';
    const href = u.toString().replace(/\/$/, '');
    if (href === self || seen.has(href)) continue;
    const path = u.pathname;
    if (ASSET.test(path)) continue;
    // A per-source pattern replaces the shape test entirely: the site told us what an
    // article URL looks like, so trust that over the generic guess.
    if (pattern) { if (!pattern.test(path)) continue; }
    else if (!fromFeed) {
      if (NOT_ARTICLE.test(path)) continue;
      const segments = path.split('/').filter(Boolean);
      if (segments.length === 0) continue;
      const last = segments[segments.length - 1];
      if (!/[a-z]{3}/i.test(last)) continue;
      const words = last.split(/[-_]/).filter((w) => /[a-z]{2}/i.test(w)).length;
      if (!/\/(19|20)\d{2}\//.test(path) && words < 4) continue;
    }
    seen.add(href);
    out.push(href);
    if (out.length >= limit) break;
  }
  return out;
}
