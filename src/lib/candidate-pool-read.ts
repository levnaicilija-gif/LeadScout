import type { SupabaseClient } from '@supabase/supabase-js';
import { allRows } from '@/lib/all-rows';
import { normName } from '@/lib/name-match';

/**
 * The candidates a dropped document is matched against — read so that a FAILURE CANNOT LOOK LIKE AN
 * EMPTY POOL.
 *
 * THIS IS THE BUG THIS FILE EXISTS FOR (found 2026-09-23, reproduced). Verify's intake read the pool
 * with `const { data: existing } = await allRows(...)` and never looked at `{ error }`. Everything
 * downstream then behaved perfectly on a lie: `known` became `[]`, judgeDuplicate found nobody to
 * compare against, and the CV created a SECOND RECORD FOR A PERSON ALREADY ON FILE with no warning
 * shown — because an empty pool does not mean "no duplicates", it means "I could not look". Two
 * records for one real person (RFBT-P-0625 and RFBT-P-0626, the same CV byte for byte, 85 seconds
 * apart) are what that looks like from the outside. Proved by mutation: with the read forced to
 * fail, dropping one CV twice makes two candidates and asks nothing; with it working, the second
 * drop creates nothing and offers the match.
 *
 * It is the same shape as the Candidates screen reading `{ data }` and rendering "No candidates yet"
 * (CLAUDE.md), and of `users.last_seen_at` never being written. A call whose failure is a value
 * nobody reads.
 *
 * A PARTIAL READ IS A FAILED READ HERE. `allRows` pages through the table and returns what it has
 * ALONG WITH the error when a later page fails, which is right for a list that wants to show what it
 * can — and wrong for this question. "Is this person already on file?" cannot be answered from some
 * of the rows: the one missing page is exactly where the duplicate would have been. So any error at
 * all makes the whole answer unusable, and the caller must refuse rather than guess.
 */

export type KnownCandidate = {
  id: string;
  reference_code: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  profile: any;
  availability_from: string | null;
  /** Normalised name, as name-match wants it. */
  key: string;
  /** Lifted out of the profile so judgeDuplicate can compare it. */
  dob: string | null;
};

export type PoolRead = {
  known: KnownCandidate[];
  /** Set when the pool could not be read IN FULL. `known` must not be used for a matching decision. */
  error: string | null;
};

/** What a caller says to the recruiter when the pool cannot be read. Never "no match found". */
export const POOL_UNREADABLE =
  'The candidate list could not be read, so there is no way to tell whether this person is already on file. Nothing has been created or changed — try again in a moment.';

export async function readPoolForMatching(db: SupabaseClient, workspaceId: string): Promise<PoolRead> {
  const { data, error } = await allRows<any>((from, to) =>
    db.from('candidates')
      .select('id, reference_code, full_name, email, phone, profile, availability_from')
      .eq('workspace_id', workspaceId)
      .order('id').range(from, to));

  if (error) return { known: [], error: error.message };

  return {
    known: (data ?? []).map((c: any) => ({
      ...c,
      key: normName(c.full_name),
      dob: c.profile?.pii?.dob ?? null,
    })),
    error: null,
  };
}
