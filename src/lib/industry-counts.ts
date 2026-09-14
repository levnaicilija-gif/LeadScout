import type { SupabaseClient } from '@supabase/supabase-js';
import { FOLLOW_OPTIONS } from '@/lib/industry';
import { hasIndustries } from '@/lib/schema-features';

export type OptionCount = { id: string; label: string; leads: number | null; hiring: number | null };

/**
 * Per follow option, what is on file today in the reader's own workspace: open won-work leads and companies with an
 * open advert. Shown beside each choice at onboarding and in Preferences, so nobody chooses blind. Null counts when
 * 0031 is not applied — the choice is still offered, the numbers are simply not shown.
 */
export async function followOptionCounts(sb: SupabaseClient): Promise<OptionCount[]> {
  const counted = await hasIndustries(sb);
  if (!counted) return FOLLOW_OPTIONS.map((o) => ({ id: o.id, label: o.label, leads: null, hiring: null }));
  const [{ data: leads }, { data: posts }] = await Promise.all([
    sb.from('leads').select('industries').eq('kind', 'won_work').not('status', 'in', '("stale","not_for_us")').limit(5000),
    sb.from('job_posts').select('company_id, companies!inner(industries)').eq('status', 'open').limit(5000),
  ]);
  const hiring = new Map<string, string[]>();
  for (const p of (posts ?? []) as any[]) hiring.set(p.company_id, p.companies?.industries ?? []);
  return FOLLOW_OPTIONS.map((o) => {
    const covers = (list: string[] | null | undefined) => (list ?? []).some((i) => (o.industries as string[]).includes(i));
    return {
      id: o.id, label: o.label,
      leads: ((leads ?? []) as any[]).filter((l) => covers(l.industries)).length,
      hiring: [...hiring.values()].filter(covers).length,
    };
  });
}
