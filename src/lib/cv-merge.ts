/**
 * What a newer CV may change on a record that already exists — item 24's update path.
 *
 * Attaching a CV to somebody already on file is how a record is KEPT UP TO DATE, not just how a
 * duplicate is avoided: a candidate sends a new CV, and their trade, languages and history should
 * follow it without anybody retyping them. The danger is the other half of that — a re-parsed CV
 * silently overwriting what a recruiter typed by hand.
 *
 * THREE TIERS (owner's decision, 2026-09-23):
 *
 *   ALWAYS      the parsed profile. It IS the reading of the newest CV, and item 24 already decided
 *               the newest CV is the current one; keeping an older reading beside a newer file would
 *               make "Read CV" show something the file does not say.
 *
 *   FILL BLANKS trade, languages, phone, email, nationality. Where the record has nothing and the CV
 *               states something, take it — that is the update the owner asked for. Where the record
 *               already holds a value and the CV disagrees, CHANGE NOTHING and report the pair, so a
 *               recruiter who corrected a phone number by hand does not find it reverted by the next
 *               CV that arrives with the old one on it.
 *
 *   NEVER       internal_notes, availability_from, stage, owner_id, data_retention_until. These are
 *               judgements a person made about a person. No CV states them, so no CV may touch them.
 *               This mirrors the rule already used for right to work, where a fact "per CV" is never
 *               allowed to overwrite one taken from a passport.
 */

/** Fields a CV may fill when the record is silent, and must only report when it disagrees. */
export const FILLABLE = ['trade', 'languages', 'phone', 'email', 'nationality'] as const;

/** Fields no CV may ever write. Listed so the rule is readable, and asserted in the check. */
export const NEVER_FROM_CV = ['internal_notes', 'availability_from', 'stage', 'owner_id', 'data_retention_until'] as const;

export type Conflict = { field: string; current: unknown; fromCv: unknown };

export type CvMerge = {
  /** Exactly what to write. Never contains a NEVER_FROM_CV field, and never overwrites a filled one. */
  patch: Record<string, unknown>;
  /** Present on both sides and different — shown to the recruiter, never written. */
  conflicts: Conflict[];
  /** Fields this CV filled in that were empty before, for the line that says what changed. */
  filled: string[];
};

const blank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);

/** Compare loosely enough that "Welder" and "welder " are not a conflict, strictly enough to notice a real change. */
const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = (Array.isArray(a) ? a : []).map((v) => String(v).trim().toLowerCase()).sort();
    const y = (Array.isArray(b) ? b : []).map((v) => String(v).trim().toLowerCase()).sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
};

/**
 * @param current  the candidate row as it stands
 * @param profile  the parsed CV
 * @param opts.isNewest  false where an OLDER CV is being attached — item 24 step 9 keeps it as
 *                       history and changes nothing at all, so the patch is empty.
 */
export function mergeFromCv(
  current: Record<string, any>,
  profile: Record<string, any>,
  opts: { isNewest?: boolean } = {},
): CvMerge {
  if (opts.isNewest === false) return { patch: {}, conflicts: [], filled: [] };

  const patch: Record<string, unknown> = { profile };
  const conflicts: Conflict[] = [];
  const filled: string[] = [];

  const fromCv: Record<string, unknown> = {
    trade: profile.trade,
    languages: profile.languages,
    phone: profile.pii?.phone,
    email: profile.pii?.email,
    nationality: profile.nationality,
  };

  for (const field of FILLABLE) {
    const incoming = fromCv[field];
    if (blank(incoming)) continue;                 // the CV says nothing: never blank a stored value
    if (blank(current[field])) { patch[field] = incoming; filled.push(field); continue; }
    if (!same(current[field], incoming)) conflicts.push({ field, current: current[field], fromCv: incoming });
  }

  return { patch, conflicts, filled };
}

/** One line a recruiter can read, or null where the CV changed nothing but the reading. */
export function mergeNote(m: CvMerge): string | null {
  const parts: string[] = [];
  if (m.filled.length) parts.push(`filled in ${m.filled.join(', ')} from this CV`);
  if (m.conflicts.length) {
    parts.push(`left ${m.conflicts.map((c) => c.field).join(', ')} as ${m.conflicts.length === 1 ? 'it is' : 'they are'} — this CV says something different, so nothing was overwritten`);
  }
  return parts.length ? `${parts.join('; ')}.` : null;
}
