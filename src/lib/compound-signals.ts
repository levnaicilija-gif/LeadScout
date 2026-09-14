import { daysSince, reAdverts, roleKey } from './lead-age';
import { leadSource, primaryArticle } from './lead-source';
import { NON_EUROPE_MAX_FIT, isEuropean } from './geo';

/**
 * Item 19 — compound signals. A company hit by several independent signals in a short window is a stronger hiring wave
 * than any one of them: an award, a news story, an open advert (a re-advertised role is that advert, stronger).
 *
 * Pure logic over what is already stored, no model call, never written back: the stored fit and pressure stay what
 * they were, and every screen that shows a boosted figure shows the figure it came from and why.
 *
 * A company with one signal type is untouched. Two or more types, each with a signal dated inside the window, raise
 * every one of that company's leads and its Hiring now row alike.
 *
 * Three types, not four (owner's decision, 2026-09-15): a role item 17 raised for re-advertising is a stronger open
 * posting, not a second source. The first cut counted it as its own type, so any raised company reached two types from
 * its own careers board alone. A boost now needs a posting together with something genuinely separate — a tender award
 * or a news mention — or those two together.
 */
export const SIGNAL_WINDOW_DAYS = 60;
/** Fit is multiplied by 1 + this for each signal type beyond the first: two types ×1.1, all three ×1.2. */
export const BOOST_PER_EXTRA_TYPE = 0.1;

export type SignalType = 'tender' | 'news' | 'hiring';
const ORDER: SignalType[] = ['tender', 'news', 'hiring'];
export const SIGNAL_LABEL: Record<SignalType, string> = {
  tender: 'tender award',
  news: 'news mention',
  hiring: 'open Hiring now posting',
};

/** One dated fact. `basis` says what the date is, so a date taken from our own first sighting never passes as the source's. */
export type Signal = { type: SignalType; date: string; basis: string };

export type Compound = {
  /** The signal types inside the window, in a fixed order. */
  types: SignalType[];
  /** The newest signal of each type inside the window. */
  newest: Signal[];
  /** 1 when fewer than two types. */
  factor: number;
  /** Days between the earliest and the latest of those newest signals. */
  spanDays: number | null;
  /** Short words for a badge, or null when there is no boost. */
  label: string | null;
  /** One sentence naming each signal, its date and what the date is. Null when there is no boost. */
  why: string | null;
};

const isoDay = (v: string | null | undefined) => {
  const s = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
};

/**
 * The signal a won-work lead is: an award from its award date, else its notice's publication; a story from its article's
 * publication. With neither, the day Radar first read it — named as such. Null when not even that is known.
 */
export function leadSignal(l: { source_url?: string | null; created_at?: string | null; lead_articles?: { articles: any }[] | null }): Signal | null {
  const a: any = primaryArticle((l.lead_articles ?? []) as any, l.source_url);
  const seen = isoDay(l.created_at);
  if (leadSource(l.source_url) === 'tender') {
    const award = isoDay(a?.award_date);
    if (award) return { type: 'tender', date: award, basis: a?.award_date_basis || 'award date' };
    const published = isoDay(a?.published_at);
    if (published) return { type: 'tender', date: published, basis: 'award notice published' };
    return seen ? { type: 'tender', date: seen, basis: 'first read by Radar — the notice states no date' } : null;
  }
  const published = isoDay(a?.published_at);
  if (published) return { type: 'news', date: published, basis: 'article published' };
  return seen ? { type: 'news', date: seen, basis: 'first read by Radar — the article states no date' } : null;
}

/**
 * A company's open postings as signals, all of one type: each advert from its posting date, else the day the crawl first
 * saw it. A role item 17 raised for re-advertising (REPOSTS_TO_BOOST) is the same signal, stronger — it is dated by its
 * latest advert and says so in its basis, so the reason can name it, but it never counts as a second type.
 */
export function postingSignals(ps: { posted_at?: string | null; first_seen_at?: string | null; role?: string | null; title?: string | null }[], now = new Date()): Signal[] {
  const out: Signal[] = [];
  for (const p of ps) {
    const posted = isoDay(p.posted_at);
    const seen = isoDay(p.first_seen_at);
    if (posted) out.push({ type: 'hiring', date: posted, basis: 'advert posted' });
    else if (seen) out.push({ type: 'hiring', date: seen, basis: 'advert first seen by our crawl — it states no posting date' });
  }
  const byRole = new Map<string, typeof ps>();
  for (const p of ps) { const k = roleKey(p) || 'Trade role'; byRole.set(k, [...(byRole.get(k) ?? []), p]); }
  for (const [role, list] of byRole) {
    const r = reAdverts(list, now);
    if (r.boosted && r.days.length) out.push({ type: 'hiring', date: r.days[r.days.length - 1], basis: `${role} re-advertised ${r.count}× (${r.days.join(', ')})` });
  }
  return out;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function compoundFor(signals: Signal[], now = new Date()): Compound {
  const inWindow = signals.filter((s) => daysSince(s.date, now) <= SIGNAL_WINDOW_DAYS);
  // Newest first; on the same day a re-advertised role is the stronger way to describe the posting signal.
  const reposted = (s: Signal) => (/re-advertised/.test(s.basis) ? 1 : 0);
  const newest = ORDER.map((t) => inWindow.filter((s) => s.type === t).sort((a, b) => b.date.localeCompare(a.date) || reposted(b) - reposted(a))[0]).filter((s): s is Signal => !!s);
  const types = newest.map((s) => s.type);
  if (types.length < 2) return { types, newest, factor: 1, spanDays: null, label: null, why: null };
  const factor = Math.round((1 + BOOST_PER_EXTRA_TYPE * (types.length - 1)) * 100) / 100;
  const dates = newest.map((s) => s.date).sort();
  const spanDays = daysSince(dates[0], new Date(`${dates[dates.length - 1]}T00:00:00Z`));
  const names = types.map((t) => SIGNAL_LABEL[t]);
  const apart = spanDays === 0 ? 'on the same day' : `${spanDays} day${spanDays === 1 ? '' : 's'} apart`;
  return {
    types, newest, factor, spanDays,
    label: `boosted ×${fmt(factor)}: ${names.join(' + ')}`,
    why: `Boosted ×${fmt(factor)} — ${types.length} independent signals inside ${SIGNAL_WINDOW_DAYS} days, ${apart}: ${newest.map((s) => `${SIGNAL_LABEL[s.type]} ${s.date} (${s.basis})`).join('; ')}.`,
  };
}

/**
 * Fit with the boost on top. Geography stays a gate: outside Europe the result is still capped at NON_EUROPE_MAX_FIT,
 * and a boost the cap swallows says so rather than showing an unexplained unchanged number.
 */
export function boostedFit(fit: number, c: Compound, country: string | null | undefined): { fit: number; from: number; boosted: boolean; note: string | null } {
  if (c.factor <= 1) return { fit, from: fit, boosted: false, note: null };
  const cap = isEuropean(country) ? 100 : NON_EUROPE_MAX_FIT;
  const raised = Math.max(fit, Math.min(cap, Math.round(fit * c.factor)));
  const note = raised === fit
    ? `${c.why} Fit stays ${fit}: ${cap === 100 ? 'already at the maximum' : `outside Europe fit is capped at ${NON_EUROPE_MAX_FIT}`}.`
    : `${c.why} Fit ${fit} → ${raised}${Math.round(fit * c.factor) > cap ? ` (capped at ${cap})` : ''}.`;
  return { fit: raised, from: fit, boosted: true, note };
}

const LEVELS = ['low', 'medium', 'high'] as const;
export type Pressure = (typeof LEVELS)[number];

/** Pressure one step up, never past high; the note says so when it was already high. */
export function boostedPressure(p: Pressure, c: Compound): { pressure: Pressure; from: Pressure; boosted: boolean; note: string | null } {
  if (c.factor <= 1) return { pressure: p, from: p, boosted: false, note: null };
  const raised = LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(p) + 1)];
  return { pressure: raised, from: p, boosted: true, note: `${c.why} Pressure ${raised === p ? `stays ${p}: already the highest` : `${p} → ${raised}`}.` };
}
