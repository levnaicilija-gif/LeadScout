import { FOLLOW_OPTIONS, type IndustryId } from '@/lib/industry';

/**
 * Item 18 part 3 — what a person follows, and the rules a choice must meet.
 *
 * These are the rules migration 0032's trigger enforces in the database. The routes check them first so a
 * refusal comes back as a plain sentence, but the routes are not the guard: the limit is read from the users
 * row for the signed-in session, and the trigger refuses a bad write whoever makes it.
 */
export const ALL = 'all';
export const FOLLOW_IDS = new Set<string>([ALL, ...FOLLOW_OPTIONS.map((o) => o.id)]);

export type FollowCheck = { ok: true; follow: string[] } | { ok: false; error: string };

/** Is this choice allowed for an account that may follow `limit` industries (null: no cap)? */
export function checkFollow(requested: unknown, limit: number | null): FollowCheck {
  if (!Array.isArray(requested) || !requested.every((x) => typeof x === 'string')) return { ok: false, error: 'Choose industries as a list.' };
  const follow = requested as string[];
  if (!follow.length) return { ok: false, error: 'Choose at least one industry.' };
  const unknown = follow.filter((f) => !FOLLOW_IDS.has(f));
  if (unknown.length) return { ok: false, error: `Not an industry on offer: ${unknown.join(', ')}.` };
  if (new Set(follow).size !== follow.length) return { ok: false, error: 'An industry is chosen twice.' };
  if (follow.includes(ALL)) {
    if (follow.length > 1) return { ok: false, error: '"All industries" is a choice of its own.' };
    if (limit != null) return { ok: false, error: `"All industries" is not available on this account, which may follow ${limit}.` };
    return { ok: true, follow };
  }
  if (limit != null && follow.length > limit) return { ok: false, error: `${follow.length} chosen; this account may follow ${limit}.` };
  return { ok: true, follow };
}

export const canFollowAll = (limit: number | null) => limit == null;

/**
 * Must this person choose before any other screen? Only when 0032 is applied (the users row carries the column)
 * and nothing is stored yet. Reads the row currentUser already loaded, so it costs no query. Existing accounts
 * were set to "all" by the migration and never land here.
 */
export const mustChooseIndustries = (me: Record<string, unknown> | null | undefined) =>
  !!me && Object.prototype.hasOwnProperty.call(me, 'industry_follow') && me.industry_follow == null;

/**
 * The industries a choice covers, or 'all'. Null — no choice stored, or 0032 not applied — reads as all: nothing
 * is filtered for someone who has not chosen, and existing accounts were set to all by the migration.
 */
export function followedIndustries(follow: string[] | null | undefined): IndustryId[] | 'all' {
  if (!follow || !follow.length || follow.includes(ALL)) return 'all';
  return [...new Set(follow.flatMap((f) => FOLLOW_OPTIONS.find((o) => o.id === f)?.industries ?? []))];
}

/** Does an item with these industries belong to what is followed? Unclassified (empty) items always show. */
export function inFollowed(itemIndustries: string[] | null | undefined, followed: IndustryId[] | 'all'): boolean {
  if (followed === 'all') return true;
  if (!itemIndustries || !itemIndustries.length) return true;
  return itemIndustries.some((i) => (followed as string[]).includes(i));
}
