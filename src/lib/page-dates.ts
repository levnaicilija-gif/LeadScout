/**
 * When a page says it was published, or a vacancy says it was posted — from the page itself.
 *
 * Only fields that are ABOUT the article or the posting count. A probe of 37 news hosts on
 * 2026-09-13 found a date on 22, and several of those were the wrong date: the website's own page
 * record ("WebPage.datePublished" — 2020 on parkwind.eu for a 2024 story, 2019 on drax.com) or the
 * first <time> in a sidebar (2020 on windtech-international.com). Those are not used.
 *
 *   published  JSON-LD NewsArticle / Article / BlogPosting / Report / PressRelease .datePublished,
 *              then meta article:published_time, og:published_time, itemprop=datePublished,
 *              then an ISO <time datetime> inside <article>
 *   posted     JSON-LD JobPosting.datePosted, and nothing else
 *
 * A date after the moment the page was read, or before 2000, is refused.
 */
import * as cheerio from 'cheerio';

export type FoundDate = { date: string; via: string };

const ARTICLE_TYPES = new Set(['NewsArticle', 'Article', 'BlogPosting', 'Report', 'PressRelease', 'ReportageNewsArticle', 'AnalysisNewsArticle', 'TechArticle']);

/** YYYY-MM-DD from an ISO-ish timestamp, or null when it is not one or is out of range. */
export function isoDay(value: unknown, readAt?: string): string | null {
  const m = String(value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const day = `${y}-${mo}-${d}`;
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t) || Number(y) < 2000 || Number(mo) > 12 || Number(d) > 31) return null;
  // A day of slack: a page stamped in a timezone ahead of ours is not from the future.
  if (readAt && t > Date.parse(readAt) + 86400000) return null;
  return day;
}

function jsonLd($: cheerio.CheerioAPI): any[] {
  const out: any[] = [];
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    out.push(o);
    if (o['@graph']) walk(o['@graph']);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try { walk(JSON.parse($(el).contents().text())); } catch { /* a malformed block is not a date */ }
  });
  return out;
}

const types = (o: any) => ([] as string[]).concat(o?.['@type'] ?? []);

export function datesFromHtml(html: string, readAt?: string): { published: FoundDate | null; posted: FoundDate | null } {
  const $ = cheerio.load(html);
  const blocks = jsonLd($);

  let published: FoundDate | null = null;
  for (const o of blocks) {
    const t = types(o).find((x) => ARTICLE_TYPES.has(x));
    const day = t ? isoDay(o.datePublished, readAt) : null;
    if (day) { published = { date: day, via: `JSON-LD ${t}.datePublished` }; break; }
  }
  if (!published) {
    for (const [sel, via] of [
      ['meta[property="article:published_time"]', 'meta article:published_time'],
      ['meta[name="article:published_time"]', 'meta article:published_time'],
      ['meta[property="og:published_time"]', 'meta og:published_time'],
      ['meta[itemprop="datePublished"]', 'meta itemprop=datePublished'],
    ] as const) {
      const day = isoDay($(sel).first().attr('content'), readAt);
      if (day) { published = { date: day, via }; break; }
    }
  }
  if (!published) {
    const day = isoDay($('article time[datetime]').first().attr('datetime'), readAt);
    if (day) published = { date: day, via: '<time datetime> inside <article>' };
  }

  let posted: FoundDate | null = null;
  for (const o of blocks) {
    if (!types(o).includes('JobPosting')) continue;
    const day = isoDay(o.datePosted, readAt);
    if (day) { posted = { date: day, via: 'JSON-LD JobPosting.datePosted' }; break; }
  }
  return { published, posted };
}

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};
const pad = (n: string) => n.padStart(2, '0');

/**
 * A dateline: one full date near the top of the stored text, for pages that carry no metadata
 * (Aker Solutions, McDermott, Worley and Vattenfall publish none). "March 19, 2026", "19 March
 * 2026", "2026-03-19" and "19.03.2026" count; a slash date does not, because 03/04/2026 is two
 * different days depending on who wrote it. If the window holds more than one distinct date,
 * which one is the publication date is a guess, so none is returned.
 */
export function datelineFromText(text: string, readAt?: string, window = 600): FoundDate | null {
  const head = String(text ?? '').slice(0, window);
  const found = new Set<string>();
  // A date only counts when the page introduces it as the publication date. Without this cue the
  // first check took "6 May" out of an Equinor dividend notice, a contract start date out of an
  // Aker Solutions release and "Page last updated" off shell.com.
  const add = (y: string, m: string | undefined, d: string, at?: number) => {
    const before = head.slice(Math.max(0, (at ?? 0) - 60), at ?? 0);
    if (!/(published|publication date|press release|news|posted)\b[^.]{0,45}$/i.test(before) || /(updated|copyright|©)[^.]{0,30}$/i.test(before)) return;
    const day = m ? isoDay(`${y}-${pad(m)}-${pad(d)}`, readAt) : null;
    if (day) found.add(day);
  };
  const month = Object.keys(MONTHS).join('|');
  for (const x of head.matchAll(new RegExp(`\\b(${month})\\.?\\s+(\\d{1,2}),?\\s+(20\\d{2})`, 'gi'))) add(x[3], MONTHS[x[1].toLowerCase()], x[2], x.index);
  for (const x of head.matchAll(new RegExp(`\\b(\\d{1,2})\\.?\\s+(${month})\\.?,?\\s+(20\\d{2})`, 'gi'))) add(x[3], MONTHS[x[2].toLowerCase()], x[1], x.index);
  for (const x of head.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) add(x[1], x[2], x[3], x.index);
  for (const x of head.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/g)) add(x[3], x[2], x[1], x.index);
  if (found.size !== 1) return null;
  return { date: [...found][0], via: `dateline in the first ${window} characters` };
}
