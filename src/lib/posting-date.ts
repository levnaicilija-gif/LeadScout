import type { SupabaseClient } from '@supabase/supabase-js';
import { httpGet } from './http';
import { datesFromHtml } from './page-dates';
import { hasPostedAtSource } from './schema-features';

/**
 * The posting date to write for a vacancy — or nothing, which leaves the stored value alone.
 *
 * Every crawl upserts each posting, and it used to write posted_at: null whenever the board's
 * list gave no date, so a date could never survive the next crawl. Now:
 *
 *   1. the date the ATS feed lists, when it lists one;
 *   2. otherwise whatever is already stored — returned as nothing, so the upsert keeps it;
 *   3. otherwise the posting's own page, read once over plain HTTP for its JobPosting.datePosted.
 *
 * A careers page's list view never carries a date, and 12 of the 38 postings stored before this
 * change state one on their own page.
 */
export async function postedFields(db: SupabaseClient, url: string, listed: string | null, listedVia: string) {
  const withSource = await hasPostedAtSource(db);
  if (listed) return { posted_at: listed, ...(withSource ? { posted_at_source: listedVia } : {}) };
  const { data: stored } = await db.from('job_posts').select('posted_at').eq('source_url', url).limit(1).maybeSingle();
  if (stored?.posted_at) return {};
  const page = await httpGet(url, {}, 15000);
  const found = page.ok ? datesFromHtml(page.body, new Date().toISOString()).posted : null;
  return found ? { posted_at: found.date, ...(withSource ? { posted_at_source: found.via } : {}) } : {};
}
