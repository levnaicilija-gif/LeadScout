/**
 * The order paid website discovery works through its queue (owner's decision, 2026-09-27).
 *
 * Same population, same total cost, same eventual coverage — only the order changes, so the
 * opportunities most likely to still be live get real contacts early in a multi-day run rather than at
 * the end of it.
 *
 * THE AGE IS ITEM 17'S, NOT `leads.created_at`, and that distinction is the whole reason this file has a
 * check. The obvious basis is the wrong one and it fails SILENTLY: the TED backfill ran on 2026-09-13, so
 * ordering on when the crawl STORED a row makes 32 of 32 news companies and 103 of 103 tender companies
 * read as "30 days or younger", and the reprioritisation becomes a no-op that reports success. On item
 * 17's real age — the award date for a tender, the article's publication for a news lead — the split is
 * 22 of 32 and 23 of 103. Measured both ways before this was written.
 *
 * UNKNOWN AGE SORTS LAST, following `latestActivityCompare` — the rule this codebase already uses when
 * ordering BY RECENCY, which is exactly what this is. 8 of the 32 news companies have no date at all,
 * their articles carrying no `published_at`, and treating "we do not know" as "brand new" would put them
 * ahead of leads measured to be two days old. The DEFAULT Leads sort deliberately treats unknown as
 * fresh, because a list nobody should have to filter must not bury undated rows; that is the right
 * answer for a screen and the wrong one for deciding what to spend money on first.
 *
 * THE OLD TIEBREAKERS ARE KEPT UNDERNEATH rather than replaced, so a run stays deterministic and
 * re-runnable: within one age bucket a retry still beats a first look, and the name still settles a tie.
 *
 * NOT EVERY POPULATION CAN USE THIS. The 145 Industry Contacts companies have NO LEADS AT ALL — they come
 * from the WindEurope import, measured 0 leads across all 145 — so there is no lead age to order them by
 * and `/api/jobs/resolve-domains` is deliberately left alone. Inventing a proxy date for them would be
 * ordering on something that does not mean what the name says, which is the mistake this file exists to
 * avoid.
 */

/** A lead age of "we could not tell" — sorts last, and is never confused with 0. */
export const AGE_UNKNOWN = Number.MAX_SAFE_INTEGER;

/** At or under this many days, a lead counts as still-live for queue purposes. */
export const FRESH_DAYS = 30;

export type Queued = { age: number; lookups: number; name: string };

/** 0 = fresh, 1 = older, 2 = no date at all. */
export const ageBucket = (t: { age: number }): 0 | 1 | 2 =>
  t.age <= FRESH_DAYS ? 0 : t.age === AGE_UNKNOWN ? 2 : 1;

/**
 * Freshest first, then older, then undated; a retry before a first look inside the same bucket; then name.
 * Pass to `Array.prototype.sort`.
 */
export const discoveryOrder = (a: Queued, b: Queued): number =>
  ageBucket(a) - ageBucket(b)
  || a.age - b.age
  || (b.lookups - a.lookups)
  || a.name.localeCompare(b.name);
