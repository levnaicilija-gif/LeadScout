import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchPage } from '@/lib/fetch-page';
import { httpGet } from '@/lib/http';
import { claude, MODEL_CLASSIFY } from '@/lib/ai/claude';
import { logCost, logModelCall, type Budget } from '@/lib/cost';

/**
 * An attendee-list person, looked for by name on their own company's site.
 *
 * The attendee list gives a name, a company and a title — never an address. The organisation-page pass follows a
 * site's leadership links and skips news and press; but a company's "our team at WindEurope" page is exactly
 * where it prints its people with their direct lines. On 2026-09-14 NorSea's Klaus Iversen Grau was a correct
 * attendee match showing "no address or number printed" while norsea.dk/news-and-events/wind-europe-2025/ printed
 * "Klaus Iversen Grau, Wind Operations Manager, Energy Solutions +45 … klaus.grau@norseagroup.com".
 *
 * What counts, and nothing else:
 *   - the name as the list wrote it is on the page;
 *   - an address in the text straight after the name, on one of the company's own domains, whose local part fits
 *     that person's name (their surname, or starting with their first name) — a page listing a team prints the
 *     next person's address right after, and that one fits the next person, not this one;
 *   - a phone number only between the name and that address; with no fitting address, nothing is taken, so a
 *     neighbour's number can never be attached to someone without one;
 *   - the title printed between the name and the number, when it reads like a title.
 *
 * Pages come from the site's sitemap or its home page's links first, which cost nothing. Neither always holds the
 * page: norsea.dk's sitemap lists its Copenhagen WindEurope page and not the 2025 one, and the site's own search
 * returns the same page for any query. searchPagesNaming then runs one web search limited to the company's own
 * domains, under the daily cap; the search only proposes addresses, and the page is still fetched and read here
 * before anything counts. Pages are read over plain HTTP — no browser session is spent.
 */
export type PersonOnPage = { name: string; title: string | null; email: string; phone: string | null; url: string; readAt: string };

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (name: string) => fold(name).replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter((t) => t.length >= 2);

export const hostOf = (domainOrUrl: string | null | undefined) =>
  (domainOrUrl ?? '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].toLowerCase();

/** Does this local part belong to this name? "klaus.grau" to Klaus Iversen Grau; "c.d.christensen" to Christian Drechsler Christensen. */
export function addressFits(local: string, name: string): boolean {
  const l = fold(local).replace(/[^a-z]/g, '');
  const t = tokens(name);
  if (t.length < 2) return false;
  const first = t[0], last = t[t.length - 1];
  return (last.length >= 3 && l.includes(last)) || (first.length >= 3 && l.startsWith(first));
}

export function personOnPage(page: { text: string; url: string; fetchedAt: string }, name: string, allowedHosts: string[]): PersonOnPage | null {
  const text = page.text.replace(/\s+/g, ' ');
  const wanted = name.replace(/\s+/g, ' ').trim();
  if (wanted.split(' ').length < 2) return null;
  const hosts = allowedHosts.map(hostOf).filter(Boolean);
  let at = text.toLowerCase().indexOf(wanted.toLowerCase());
  while (at >= 0) {
    const after = text.slice(at + wanted.length, at + wanted.length + 240);
    const m = after.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    if (m && m.index !== undefined) {
      // A page whose text runs the number into the address ("+45 21 94 41 70klaus.grau@…" on norsea.dk) would
      // otherwise give a phone one pair short and an address that does not exist: digits glued to the front of
      // an address, straight after a number, belong to the number.
      const lead = m[0].match(/^(\d+)(?=[a-z])/i)?.[1] ?? '';
      const glued = lead && /\d[\d ().\/-]*$/.test(after.slice(0, m.index)) ? lead : '';
      const address = m[0].slice(glued.length).toLowerCase().replace(/\.$/, '');
      const [local, host] = address.split('@');
      if (local && hosts.some((h) => host === h || host.endsWith(`.${h}`)) && addressFits(local, wanted)) {
        const upto = after.slice(0, m.index + glued.length);
        const p = upto.match(/\+?\d[\d ().\/-]{6,}\d/);
        const phone = p && p[0].replace(/\D/g, '').length >= 8 ? p[0].trim() : null;
        const between = upto.slice(0, p?.index ?? upto.length).replace(/^[\s,:;|–—-]+/, '').replace(/[\s,:;|–—-]+$/, '');
        const title = between && between.length <= 90 && !/@|\d{3,}/.test(between) ? between : null;
        return { name: wanted, title, email: address, phone, url: page.url, readAt: page.fetchedAt };
      }
    }
    at = text.toLowerCase().indexOf(wanted.toLowerCase(), at + 1);
  }
  return null;
}

const SKIP = /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|mp4)(\?|$)|\/(tag|category|author|wp-content|feed)\//i;
const GOOD: [RegExp, number][] = [
  // The event the attendee list came from outranks any other event page: every news-and-events page used to tie.
  [/wind-?europe/i, 6],
  [/event|exhibition|messe|fair|conference|stand|booth/i, 3],
  [/team|people|our-people|medarbejder|ansatte|employees|staff|kontakt|contact/i, 3],
  [/news|nyhed|nyhet|press|presse|media|insight/i, 2],
  [/about|om-os|om-oss|over-ons|management|leadership/i, 1],
];

/** URLs from a site's sitemap, or its home page's own links when it has none. */
export async function siteUrls(host: string, limit = 1500): Promise<{ urls: string[]; via: 'sitemap' | 'home page' | 'nothing' }> {
  const urls: string[] = [];
  const queue = [`https://${host}/sitemap.xml`, `https://${host}/sitemap_index.xml`, `https://www.${host}/sitemap.xml`];
  const seen = new Set<string>();
  while (queue.length && urls.length < limit && seen.size < 10) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    const r = await httpGet(u, {}, 15000);
    if (!r.ok || !/<(urlset|sitemapindex)/i.test(r.body)) continue;
    const locs = [...r.body.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)/g)].map((x) => x[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(r.body)) queue.push(...locs.filter((l) => !/product|image|video|attachment/i.test(l)).slice(0, 8));
    else urls.push(...locs);
  }
  if (urls.length) return { urls: [...new Set(urls)].slice(0, limit), via: 'sitemap' };
  const home = await fetchPage(`https://${host}`);
  const own = (home.links ?? []).filter((l) => hostOf(l) === host);
  return own.length ? { urls: [...new Set(own)].slice(0, limit), via: 'home page' } : { urls: [], via: 'nothing' };
}

/** Pages most likely to print these people, best first: their surname in the address, then event, team, news pages. */
export function rankPages(urls: string[], names: string[], max: number): string[] {
  const surnames = names.map((n) => tokens(n).at(-1)).filter((s): s is string => !!s && s.length >= 3);
  return urls
    .filter((u) => !SKIP.test(u))
    .map((u) => {
      const path = fold(decodeURIComponent(u.replace(/^https?:\/\/[^/]+/, '')));
      let score = surnames.some((s) => path.includes(s)) ? 10 : 0;
      for (const [re, w] of GOOD) if (re.test(path)) score += w;
      return { u, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.u);
}

/** Look for each person on the given company sites. One crawl per site, every person checked on every page. */
export async function findPeopleOnSites(names: string[], hosts: string[], opts: { maxPagesPerSite?: number } = {}) {
  const found = new Map<string, PersonOnPage>();
  const sites: { host: string; via: string; urls: number; read: number }[] = [];
  const allowed = [...new Set(hosts.map(hostOf).filter(Boolean))];
  for (const host of allowed) {
    const left = names.filter((n) => !found.has(n));
    if (!left.length) break;
    const { urls, via } = await siteUrls(host);
    const pages = rankPages(urls, left, opts.maxPagesPerSite ?? 30);
    let read = 0;
    for (const url of pages) {
      const page = await fetchPage(url);
      read++;
      if (page.status !== 'live' || !page.text) continue;
      for (const n of names) {
        if (found.has(n)) continue;
        const hit = personOnPage({ text: page.text, url, fetchedAt: page.fetchedAt }, n, allowed);
        if (hit) found.set(n, hit);
      }
      if (names.every((n) => found.has(n))) break;
    }
    sites.push({ host, via, urls: urls.length, read });
  }
  return { found, sites };
}

/** Anthropic bills a web search per search on top of tokens; the same assumed rate resolve-domains logs. */
export const SEARCH_EUR = Number(process.env.WEB_SEARCH_EUR_PER_CALL ?? 0.0092);

/**
 * One web search for pages on the company's own domains that mention this person. Returns addresses on those
 * domains only; nothing here is a contact until personOnPage reads it on the fetched page. Refused when the daily
 * cap cannot take it, and logged whenever it spends.
 */
export async function searchPagesNaming(
  name: string,
  hosts: string[],
  ctx: { db: SupabaseClient; workspaceId: string; budget: Budget; label: string },
): Promise<{ urls: string[]; eur: number; skipped?: string }> {
  const allowed = [...new Set(hosts.map(hostOf).filter(Boolean))];
  if (!allowed.length) return { urls: [], eur: 0, skipped: 'no company site' };
  if (!ctx.budget.canAfford(SEARCH_EUR + 0.02)) return { urls: [], eur: 0, skipped: 'daily cap' };
  const r: any = await claude.messages.create({
    model: MODEL_CLASSIFY, max_tokens: 150,
    system: 'Search once for pages that mention the person named, using the web search tool. Do not answer from memory. After searching, reply with the single word done.',
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1, allowed_domains: allowed }],
    messages: [{ role: 'user', content: `"${name}"` }],
  } as any);
  let eur = await logModelCall(ctx.db, ctx.workspaceId, MODEL_CLASSIFY, `person search at ${ctx.label}`, r.usage);
  if ((r.content ?? []).some((b: any) => b.type === 'server_tool_use')) {
    await logCost(ctx.db, ctx.workspaceId, 'search', `web search · a person at ${ctx.label}`, 1, SEARCH_EUR);
    eur += SEARCH_EUR;
  }
  ctx.budget.add(eur);
  const urls = ((r.content ?? []) as any[])
    .filter((b) => b.type === 'web_search_tool_result' && Array.isArray(b.content))
    .flatMap((b) => b.content.map((x: any) => String(x.url ?? '')))
    .filter((u: string) => { const h = hostOf(u); return !!h && allowed.some((a) => h === a || h.endsWith(`.${a}`)); });
  return { urls: [...new Set<string>(urls)].slice(0, 5), eur };
}
