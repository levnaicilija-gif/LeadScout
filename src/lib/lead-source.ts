/**
 * Where a lead came from: a news story Radar read, or a contract award notice.
 *
 * Read off the lead's source URL rather than stored in a column of its own. The URL is already
 * the evidence the lead stands on, so the tag cannot disagree with it — and no migration has to
 * be applied by hand before the tag can show.
 */
export type LeadSource = 'tender' | 'news';

/** Hosts that publish award notices. TED only for now; Doffin joins when its API key exists. */
const TENDER_HOSTS = ['ted.europa.eu'];

export function leadSource(url: string | null | undefined): LeadSource {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return TENDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? 'tender' : 'news';
  } catch {
    return 'news';
  }
}

export const LEAD_SOURCE_LABEL: Record<LeadSource, string> = { tender: 'Tender award', news: 'News' };

/** How a flagged source reads on screen. The rules that set a flag are in source-quality.ts. */
export const SOURCE_FLAG_LABEL: Record<string, string> = {
  broken: 'source is gone', unreachable: 'source did not load', landing: 'link lands on a landing page', paywall: 'source is behind a paywall', sign_in: 'source needs a sign-in',
};

/**
 * The tag's look, as whole class names (Tailwind cannot build one at runtime). Neither a status
 * colour nor a tool colour: where a lead came from is not how a fact stands, and not which screen
 * you are on. An award is outlined on white, a story filled grey, and the word says which.
 */
export const LEAD_SOURCE_BADGE: Record<LeadSource, string> = {
  tender: 'badge bg-panel border border-ink3 text-ink',
  news: 'badge',
};

/** The article a lead stands on: the one its source URL points at (an award's carries #winner-N), else the first linked. */
export function primaryArticle<T extends { url?: string | null }>(links: { articles: T | null }[] | null | undefined, sourceUrl: string | null | undefined): T | null {
  const list = (links ?? []).map((x) => x.articles).filter(Boolean) as T[];
  return list.find((a) => a.url && String(sourceUrl ?? '').startsWith(a.url)) ?? list[0] ?? null;
}
