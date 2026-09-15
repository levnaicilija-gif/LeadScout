/**
 * Item 21, read only: did the discovery pass read each won-work company once, not once per lead?
 *
 *   npx tsx --env-file=.env.local scripts/wonwork-contacts-cache-check.ts [--since 2026-09-15T00:00:00Z]
 *
 *   - companies behind open won-work leads, with a site on file, stamped contacts_checked_at since the given time;
 *   - organisation-page reads logged per company since then (cost_log "organisation page at <company>"): the pass reads
 *     at most two such pages for a company, so more than two for one company means it was read again;
 *   - for companies behind two or more leads, the same: one stamp, reads no higher than for a single-lead company.
 */
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const sinceAt = process.argv.indexOf('--since');
const since = sinceAt > 0 ? process.argv[sinceAt + 1] : new Date(Date.now() - 6 * 3600_000).toISOString();

(async () => {
  const { data: ws } = await db.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const { data: leads, error } = await db.from('leads').select('id, company_id, companies(id, name, domain, careers_url, contact_page_url, contacts_checked_at)')
    .eq('workspace_id', ws!.id).eq('kind', 'won_work').eq('is_test', false).not('status', 'in', '("stale","not_for_us")').not('company_id', 'is', null).limit(5000);
  if (error) throw new Error(error.message);
  const byCo = new Map<string, { name: string; leads: number; site: boolean; stampedSince: boolean }>();
  for (const l of leads ?? []) {
    const c: any = l.companies;
    const e = byCo.get(l.company_id) ?? { name: c?.name ?? '?', leads: 0, site: !!(c?.domain || c?.careers_url || c?.contact_page_url), stampedSince: !!c?.contacts_checked_at && c.contacts_checked_at >= since };
    e.leads++;
    byCo.set(l.company_id, e);
  }
  const withSite = [...byCo.values()].filter((c) => c.site);
  const logs: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('cost_log').select('detail, created_at').eq('kind', 'hiring-contacts').gte('created_at', since).order('created_at').range(from, from + 999);
    logs.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const orgReads = new Map<string, number>();
  for (const r of logs) { const m = String(r.detail).match(/^organisation page at (.+)$/); if (m) orgReads.set(m[1], (orgReads.get(m[1]) ?? 0) + 1); }
  const over = withSite.filter((c) => (orgReads.get(c.name) ?? 0) > 2);
  const shared = withSite.filter((c) => c.leads > 1);
  console.log(`since ${since}`);
  console.log(`won-work companies: ${byCo.size} · with a site on file: ${withSite.length} · stamped read since: ${withSite.filter((c) => c.stampedSince).length} · without a site stamped (should be 0): ${[...byCo.values()].filter((c) => !c.site && c.stampedSince).length}`);
  console.log(`organisation-page reads logged since: ${[...orgReads.values()].reduce((a, b) => a + b, 0)} over ${orgReads.size} companies · companies with more than two (read again): ${over.length}${over.length ? ` — ${over.map((c) => `${c.name} ×${orgReads.get(c.name)}`).join(', ')}` : ''}`);
  console.log(`companies behind two or more leads, with a site: ${shared.length}${shared.length ? ` — ${shared.map((c) => `${c.name} (${c.leads} leads, ${c.stampedSince ? 'stamped once' : 'not stamped'}, ${orgReads.get(c.name) ?? 0} org-page reads)`).join('; ')}` : ''}`);
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
