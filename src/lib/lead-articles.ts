import { supabaseAdmin } from '@/lib/supabase/server';

export type LinkedArticle = { articles: { url: string; title?: string | null; published_at: string | null; fetched_at?: string | null; award_date?: string | null; award_date_basis?: string | null } | null };
export type LinkedPerson = { people: { name: string; title: string | null; source: string | null } | null };

/**
 * Rows hanging off leads the caller has already loaded, read with the service role.
 *
 * articles, lead_articles and lead_people have row level security on and, until migration 0025, no
 * policy: on 2026-09-13 a signed-in user read 0 of 605 articles, 0 of 141 article links and 0 of 146
 * attendee links, so every lead looked undated, "+N sources" never showed and nobody from an attendee
 * list appeared. Only lead ids the caller loaded under the user's own RLS are asked for, so nothing
 * from another workspace can come back — the pattern api/hiring used for contacts before 0022.
 *
 * A failed read is returned, never swallowed: an empty map would look like leads with nothing behind them.
 */
async function byLead<T>(table: 'lead_articles' | 'lead_people', select: string, leadIds: string[], pick: (row: any) => T) {
  const out = new Map<string, T[]>();
  const db = supabaseAdmin();
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data, error } = await db.from(table).select(`lead_id, ${select}`).in('lead_id', leadIds.slice(i, i + 100));
    if (error) return { byLead: out, error: error.message };
    for (const r of (data ?? []) as any[]) out.set(r.lead_id, [...(out.get(r.lead_id) ?? []), pick(r)]);
  }
  return { byLead: out, error: null as string | null };
}

/** `extraCols` names article columns that may not exist yet (", award_date, award_date_basis"). */
export const articlesByLead = (leadIds: string[], extraCols = '') =>
  byLead<LinkedArticle>('lead_articles', `articles(url, title, published_at, fetched_at${extraCols})`, leadIds, (r) => ({ articles: r.articles }));

export const peopleByLead = (leadIds: string[]) =>
  byLead<LinkedPerson>('lead_people', 'people(name, title, source)', leadIds, (r) => ({ people: r.people }));
