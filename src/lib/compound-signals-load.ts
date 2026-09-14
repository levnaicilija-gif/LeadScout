import type { SupabaseClient } from '@supabase/supabase-js';
import { articlesByLead } from './lead-articles';
import { compoundFor, leadSignal, postingSignals, type Compound, type Signal } from './compound-signals';

/**
 * Item 19's signals for a set of companies, as the signed-in user may read them.
 *
 * Leads and postings are read under the user's own RLS; the article dates behind those leads through
 * `articlesByLead`, which asks only for lead ids already loaded that way. Open won-work leads only — the ones
 * Leads shows — and open postings, whatever the Hiring now filters on screen hide.
 *
 * A failed read comes back as `error`, never as "no boost": a company that could not be checked is not a company
 * with one signal.
 */
export async function compoundByCompany(sb: SupabaseClient, companyIds: string[], awardCols = '', now = new Date()): Promise<{ byCompany: Map<string, Compound>; error: string | null }> {
  const ids = [...new Set(companyIds.filter(Boolean))];
  const byCompany = new Map<string, Compound>();
  if (!ids.length) return { byCompany, error: null };
  const signals = new Map<string, Signal[]>();
  const add = (id: string, s: Signal[]) => signals.set(id, [...(signals.get(id) ?? []), ...s]);

  const leads: any[] = [];
  const posts: any[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const [l, p] = await Promise.all([
      sb.from('leads').select('id, company_id, source_url, created_at').eq('kind', 'won_work').not('status', 'in', '("stale","not_for_us")').in('company_id', chunk),
      sb.from('job_posts').select('company_id, role, title, posted_at, first_seen_at').eq('status', 'open').in('company_id', chunk),
    ]);
    if (l.error) return { byCompany, error: `the company's other leads could not be read: ${l.error.message}` };
    if (p.error) return { byCompany, error: `the company's open postings could not be read: ${p.error.message}` };
    leads.push(...(l.data ?? []));
    posts.push(...(p.data ?? []));
  }

  const { byLead, error } = await articlesByLead(leads.map((l) => l.id), awardCols);
  if (error) return { byCompany, error: `the dates behind the company's leads could not be read: ${error}` };
  for (const l of leads) {
    const s = leadSignal({ ...l, lead_articles: byLead.get(l.id) ?? [] });
    if (s) add(l.company_id, [s]);
  }
  const postsBy = new Map<string, any[]>();
  for (const p of posts) postsBy.set(p.company_id, [...(postsBy.get(p.company_id) ?? []), p]);
  for (const [id, ps] of postsBy) add(id, postingSignals(ps, now));

  for (const id of ids) byCompany.set(id, compoundFor(signals.get(id) ?? [], now));
  return { byCompany, error: null };
}
