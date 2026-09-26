/**
 * Item 19's before/after on real data. Read only.
 *
 *   npx tsx --env-file=.env.local scripts/compound-signals-report.ts
 *
 * For every company with an open won-work lead or an open posting: its signals inside the window, and — for each company
 * with two or more types — every lead's fit and its Hiring now pressure, unboosted and boosted, with the note the screen
 * shows. Pressure "before" is Hiring now's own groupByCompany, so it is the word the screen shows today.
 */
import { createClient } from '@supabase/supabase-js';
import { compoundFor, boostedFit, boostedPressure, leadSignal, postingSignals, SIGNAL_WINDOW_DAYS, type Signal } from '../src/lib/compound-signals';
import { groupByCompany } from '../src/components/HiringNow';
import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE } from '../src/lib/workspace-state';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
const OPEN = '("stale","not_for_us")';

(async () => {
  const { data: leads, error } = await db.from('leads').select(`id, company_id, country, fit_score, source_url, created_at, project_name, companies(name), ${LEAD_STATE_EMBED}`)
    .eq('kind', 'won_work').not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES).eq('is_test', false).not('company_id', 'is', null).limit(5000);
  if (error) throw new Error(error.message);
  const links: any[] = [];
  const ids = (leads ?? []).map((l) => l.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error: e } = await db.from('lead_articles').select('lead_id, articles(url, published_at, award_date, award_date_basis)').in('lead_id', ids.slice(i, i + 100));
    if (e) throw new Error(e.message);
    links.push(...(data ?? []));
  }
  const byLead = new Map<string, any[]>();
  for (const k of links) (byLead.get(k.lead_id) ?? byLead.set(k.lead_id, []).get(k.lead_id)!).push({ articles: k.articles });
  const { data: posts, error: pe } = await db.from('job_posts')
    .select('id, company_id, title, role, location, country, trades, certs_required, headcount, posted_at, first_seen_at, source_url, via, companies!inner(name, employer_type, country)')
    .eq('status', 'open').not('company_id', 'is', null).eq('is_test', false).limit(5000);
  if (pe) throw new Error(pe.message);

  const signals = new Map<string, { name: string; list: Signal[] }>();
  const at = (id: string, name: string) => signals.get(id) ?? signals.set(id, { name, list: [] }).get(id)!;
  let fromFirstSighting = 0;
  for (const l of leads ?? []) {
    const s = leadSignal({ ...l, lead_articles: byLead.get(l.id) ?? [] });
    if (!s) continue;
    if (/first read by Radar/.test(s.basis)) fromFirstSighting++;
    at(l.company_id, (l as any).companies?.name ?? '?').list.push(s);
  }
  const postsBy = new Map<string, any[]>();
  for (const p of posts ?? []) (postsBy.get(p.company_id) ?? postsBy.set(p.company_id, []).get(p.company_id)!).push(p);
  for (const [cid, ps] of postsBy) at(cid, ps[0].companies?.name ?? '?').list.push(...postingSignals(ps));

  const groups = new Map(groupByCompany((posts ?? []) as any).map((g) => [g.companyId, g]));
  const compounds = [...signals.entries()].map(([id, v]) => ({ id, name: v.name, c: compoundFor(v.list) }));
  const boosted = compounds.filter((x) => x.c.factor > 1);
  const byCount = (n: number) => compounds.filter((x) => x.c.types.length === n).length;
  console.log(`companies with a signal inside ${SIGNAL_WINDOW_DAYS} days: ${compounds.filter((x) => x.c.types.length).length} · one type ${byCount(1)} · two ${byCount(2)} · three ${byCount(3)}`);
  console.log(`won-work signals dated only by Radar's first reading (the source states no date): ${fromFirstSighting} of ${(leads ?? []).length}`);
  console.log(`\nboosted companies: ${boosted.length}`);
  for (const b of boosted) {
    console.log(`\n${b.name} — ${b.c.label}\n  ${b.c.why}`);
    for (const l of (leads ?? []).filter((x) => x.company_id === b.id)) {
      const f = boostedFit(l.fit_score ?? 0, b.c, l.country);
      console.log(`  lead "${String(l.project_name ?? '').slice(0, 60)}" (${l.country}): fit ${f.from} → ${f.fit}${f.fit === f.from ? ' (unchanged)' : ''}`);
    }
    const g = groups.get(b.id);
    if (g) { const p = boostedPressure(g.pressure, b.c); console.log(`  Hiring now row: pressure ${p.from} → ${p.pressure} · ${g.openings} opening(s)`); }
  }
  const near = compounds.filter((x) => x.c.types.length === 1 && signals.get(x.id)!.list.some((s) => !x.c.types.includes(s.type)));
  console.log(`\none type inside the window but another type outside it (would boost if both were recent): ${near.length}${near.length ? ` — ${near.slice(0, 8).map((x) => `${x.name} (${[...new Set(signals.get(x.id)!.list.map((s) => s.type))].join('+')})`).join(', ')}` : ''}`);
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
