import type { SupabaseClient } from '@supabase/supabase-js';
import { INDUSTRIES, type IndustryId } from '@/lib/industry';
import { followedIndustries } from '@/lib/industry-follow';
import { hasIndustries, hasIndustryFollow, hasTestFlag } from '@/lib/schema-features';

/**
 * Item 18 part 4 — companies somebody follows get looked at more often. Sourcing stays shared: this changes how
 * often a company's own careers board is read, never which sources exist or who they are read for.
 *
 * A company is watched when its industries (0031) include one that at least one real account follows (0032). A
 * person following all industries follows every category except Other / Uncategorized. The job crawl reads every
 * board once a day; a watched board is read again once it is WATCH_RECRAWL_HOURS old (src/lib/jobs/tick.ts), under
 * the same daily budget as everything else. Measured 2026-09-14: 14 watched boards, about €0.00018 a board read,
 * so roughly €0.003 a day more.
 *
 * Radar is not part of it: sources are newsrooms and trade press, not linked to companies, so there is no
 * company-by-company news re-check to make more often without adding sources — which this item does not do.
 */
export const WATCH_RECRAWL_HOURS = 12;

/** The industries followed by at least one real account, or null before 0031 and 0032. */
export async function watchedIndustries(db: SupabaseClient): Promise<{ industries: IndustryId[]; followers: number } | null> {
  if (!(await hasIndustryFollow(db)) || !(await hasIndustries(db))) return null;
  let wsQuery = db.from('workspaces').select('id');
  if (await hasTestFlag(db)) wsQuery = wsQuery.eq('is_test', false);
  const { data: workspaces, error: wsErr } = await wsQuery;
  if (wsErr) throw new Error(`workspaces could not be read: ${wsErr.message}`);
  const ids = (workspaces ?? []).map((w: any) => w.id);
  if (!ids.length) return { industries: [], followers: 0 };
  const { data: users, error } = await db.from('users').select('industry_follow').in('workspace_id', ids).not('industry_follow', 'is', null);
  if (error) throw new Error(`what people follow could not be read: ${error.message}`);
  const union = new Set<IndustryId>();
  for (const u of users ?? []) {
    const f = followedIndustries((u as any).industry_follow);
    (f === 'all' ? INDUSTRIES.map((i) => i.id).filter((i) => i !== 'other') : f).forEach((i) => union.add(i as IndustryId));
  }
  return { industries: [...union], followers: (users ?? []).length };
}

/** Watched companies with a careers board, and how many of them are due a second read. */
export async function watchedBoards(db: SupabaseClient, now = new Date()): Promise<{ ids: string[]; dueIds: string[] } | null> {
  const watched = await watchedIndustries(db);
  if (!watched || !watched.industries.length) return watched ? { ids: [], dueIds: [] } : null;
  const { data, error } = await db.from('companies').select('id, last_jobs_crawl_at')
    .eq('careers_status', 'found').neq('employer_type', 'staffing_agency')
    .overlaps('industries', watched.industries).limit(2000);
  if (error) throw new Error(`watched companies could not be read: ${error.message}`);
  const cutoff = now.getTime() - WATCH_RECRAWL_HOURS * 3600000;
  const rows = (data ?? []) as { id: string; last_jobs_crawl_at: string | null }[];
  return { ids: rows.map((r) => r.id), dueIds: rows.filter((r) => !r.last_jobs_crawl_at || Date.parse(r.last_jobs_crawl_at) < cutoff).map((r) => r.id) };
}
