/**
 * Per-source crawl rules. The generic article-shape heuristic in articleLinks() gets most
 * sites; these are the ones it cannot, recorded against what the site actually serves.
 *
 * A rule can:
 *   index    crawl a different page than the source url (a root that lists nothing useful)
 *   pattern  accept links whose pathname matches, bypassing the shape test
 *   browser  the site is client-rendered — do not waste a plain fetch on it
 *
 * `sources.link_rule` (migration 0005) overrides these per workspace without a deploy.
 */
export type SourceRule = { index?: string; pattern?: RegExp; browser?: boolean; why: string };

const RULES: Record<string, SourceRule> = {
  // Articles live at /<section>/<slug>/2-1-<id>; the last path segment is the numeric id, so
  // the "four-word slug" test never matches. The root lists only section links — /latest lists
  // the stories. Checked 2026-09-09.
  'rechargenews.com': {
    index: 'https://www.rechargenews.com/latest',
    pattern: /\/\d+-\d+-\d{5,}$/,
    why: 'article ids look like /2-1-2039605, and the root page lists sections rather than stories',
  },
  // Every path on this host returns the identical 51,915-byte shell with the same 45 nav
  // links — the article list is rendered client-side. Checked 2026-09-09.
  'offshorewindindustry.com': {
    browser: true,
    why: 'every URL serves the same JavaScript shell; the article list is client-rendered',
  },
};

export function ruleFor(url: string, dbRule?: string | null): SourceRule | undefined {
  if (dbRule) {
    try {
      const parsed = JSON.parse(dbRule) as { index?: string; pattern?: string; browser?: boolean };
      return { index: parsed.index, pattern: parsed.pattern ? new RegExp(parsed.pattern) : undefined, browser: parsed.browser, why: 'sources.link_rule' };
    } catch {
      // A bare string is treated as the pathname pattern.
      return { pattern: new RegExp(dbRule), why: 'sources.link_rule' };
    }
  }
  let host: string;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return undefined; }
  return RULES[host];
}
