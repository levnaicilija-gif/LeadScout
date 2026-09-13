/**
 * Queue item 17 — how old a signal is, and what its age does to its priority.
 *
 * Computed whenever a screen reads a lead or a posting; never stored, never written anywhere. A
 * lead's status is the recruiter's, and an automated rule only flags — the owner's decision for
 * item 14's nightly recheck, kept here. A flagged or stale lead stays in the list, lower and dimmer.
 *
 * "stale signal" is not the status "stale". That status is a recruiter's decision and hides a
 * lead; this is arithmetic on a date and hides nothing.
 *
 * A missing date is neither a penalty nor a pass: it is "age unknown", said plainly, and it sorts
 * with the fresh ones rather than below them.
 */

export const AGE_RULES = {
  /** A news story about won work, from the article's own publication date. */
  news: { flagDays: 45, staleDays: 90 },
  /** A contract award notice, from the award decision, else the contract's conclusion, else the notice's publication. */
  tender: { flagDays: 180, staleDays: 365 },
  /** A job advert, from its posting date, else the day the crawl first saw it. Flagged, never stale. */
  posting: { flagDays: 60, staleDays: null },
} as const;

/** Re-advertising counts inside this many days back from today. */
export const REPOST_WINDOW_DAYS = 180;
/** Re-advertised this many times, on top of the first advert, raises a role's priority. */
export const REPOSTS_TO_BOOST = 2;

export type AgeKind = keyof typeof AGE_RULES;
export type AgeState = 'fresh' | 'flagged' | 'stale' | 'unknown';
export type Age = {
  state: AgeState;
  days: number | null;
  /** YYYY-MM-DD, the date measured from. */
  date: string | null;
  /** What that date is: "article published", "award decision", "posted", "first seen by our crawl"… */
  basis: string | null;
  /** Short words for a table cell. */
  label: string;
  /** One sentence for a hover or a drawer: the date, what it is, and the thresholds. */
  why: string;
};

const DAY = 86_400_000;
const isoDay = (v: string | null | undefined) => {
  const s = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
};

/** Whole UTC calendar days from a date to today. A date in the future is 0 days old. */
export function daysSince(date: string, now: Date = new Date()): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((today - Date.parse(`${date.slice(0, 10)}T00:00:00Z`)) / DAY));
}

const inDays = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

function judge(kind: AgeKind, date: string | null, basis: string, noDate: string, now: Date): Age {
  const r = AGE_RULES[kind];
  const limits = `flagged from ${r.flagDays} days${r.staleDays === null ? '' : `, stale from ${r.staleDays}`}`;
  if (!date) {
    return { state: 'unknown', days: null, date: null, basis: null, label: 'age unknown', why: `Age unknown — ${noDate}. Neither flagged nor raised for that.` };
  }
  const days = daysSince(date, now);
  const state: AgeState = r.staleDays !== null && days >= r.staleDays ? 'stale' : days >= r.flagDays ? 'flagged' : 'fresh';
  const label = state === 'stale' ? `stale signal · ${inDays(days)}` : state === 'flagged' ? `ageing · ${inDays(days)}` : `${inDays(days)} old`;
  return { state, days, date, basis, label, why: `${basis[0].toUpperCase()}${basis.slice(1)} ${date}, ${inDays(days)} ago — ${limits}.` };
}

export function newsLeadAge(a: { publishedAt?: string | null }, now = new Date()): Age {
  return judge('news', isoDay(a.publishedAt), 'article published', 'the article states no publication date', now);
}

/**
 * `awardDateRead` is false while migration 0024 is missing: the award date is then in the notice's
 * text but not loaded, and the label must not claim the notice states none.
 */
export function tenderLeadAge(a: { awardDate?: string | null; awardBasis?: string | null; publishedAt?: string | null; awardDateRead?: boolean }, now = new Date()): Age {
  const award = isoDay(a.awardDate);
  if (award) return judge('tender', award, a.awardBasis || 'award date', '', now);
  const missing = a.awardDateRead === false ? 'award date not loaded yet' : 'the notice states no award date';
  return judge('tender', isoDay(a.publishedAt), `award notice published (${missing})`, 'the notice states neither an award date nor a publication date', now);
}

export function postingAge(p: { posted_at?: string | null; first_seen_at?: string | null }, now = new Date()): Age {
  const posted = isoDay(p.posted_at);
  if (posted) return judge('posting', posted, 'posted', '', now);
  return judge('posting', isoDay(p.first_seen_at), 'first seen by our crawl (the advert states no posting date)', 'the advert states no posting date and the crawl recorded no first sighting', now);
}

/** Two "Servicemonteur" adverts in two towns are one role hiring twice. Hiring now groups on this too. */
export const roleKey = (p: { role?: string | null; title?: string | null }) =>
  (p.role ?? p.title ?? '').replace(/\s*[-–—|,(].*$/, '').replace(/\s+/g, ' ').trim();

export type Readverts = { count: number; days: string[]; boosted: boolean; label: string | null; why: string | null };

/**
 * How many times one role at one company was advertised again inside the window.
 *
 * Adverts count by the day they carry — posting date, else first seen. Several adverts on one day
 * are several openings at once, not a role that failed to fill: wet pro's three "Monteur Technische
 * Dienst" adverts were all first seen on 10 September 2026. An advert with no date cannot be placed
 * in a window, so it counts for nothing either way.
 */
export function reAdverts(adverts: { posted_at?: string | null; first_seen_at?: string | null }[], now = new Date()): Readverts {
  const days = [...new Set(adverts.map((p) => isoDay(p.posted_at) ?? isoDay(p.first_seen_at)).filter((d): d is string => !!d))]
    .filter((d) => daysSince(d, now) <= REPOST_WINDOW_DAYS)
    .sort();
  const count = Math.max(0, days.length - 1);
  return {
    count,
    days,
    boosted: count >= REPOSTS_TO_BOOST,
    label: count ? `re-advertised ${count}× in ${REPOST_WINDOW_DAYS} days` : null,
    why: count ? `Advertised on ${days.join(', ')}` : null,
  };
}

/**
 * Sort weight, lower first. Age unknown sits with fresh. A role re-advertised often enough goes
 * above both, even when its newest advert is ageing: repeated reposting is demand, not decay.
 */
export const ageSink = (state: AgeState, boosted = false) => (boosted ? -1 : state === 'stale' ? 2 : state === 'flagged' ? 1 : 0);

/** How each state reads. Ageing takes the warn colour — worth a look; stale is quiet ink, not "bad": an old signal is not a failure. */
export const AGE_TEXT: Record<AgeState, string> = { fresh: 'text-ink3', unknown: 'text-ink3', flagged: 'text-warn font-medium', stale: 'text-ink2 font-medium' };
/** Deprioritised on screen, never hidden. */
export const AGE_DIM: Record<AgeState, string> = { fresh: '', unknown: '', flagged: 'opacity-80', stale: 'opacity-60' };
