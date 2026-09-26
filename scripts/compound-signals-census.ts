/**
 * Read only, before any code: which companies have two or more of the four signal types inside 60 days, by the raw data.
 *
 *   npx tsx --env-file=.env.local scripts/compound-signals-census.ts
 *
 * Signal dates: an award from articles.award_date, else its notice's published_at, else the lead's created_at; a news
 * lead from its article's published_at, else created_at; a posting from posted_at, else first_seen_at. Also prints how
 * many signals had only the fallback date, because that decides how honest a "within 60 days" can be.
 */
import { createClient } from '@supabase/supabase-js';
import { reAdverts, roleKey } from '../src/lib/lead-age';
import { leadSource } from '../src/lib/lead-source';
import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE } from '../src/lib/workspace-state';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
const DAY = 86_400_000;
const within = (d: string | null | undefined, days = 60) => !!d && Date.now() - Date.parse(String(d).slice(0, 10)) <= days * DAY;

(async () => {
  // leads.status was dropped by 0049 and this census never read it, so it is simply gone from the
  // select rather than fetched from the state row for nothing.
  const { data: leads, error } = await db.from('leads').select(`id, company_id, kind, source_url, created_at, fit_score, is_test, companies(name), ${LEAD_STATE_EMBED}`)
    .eq('kind', 'won_work').not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES).eq('is_test', false).limit(5000);
  if (error) throw new Error(error.message);
  const { data: links } = await db.from('lead_articles').select('lead_id, articles(url, published_at, award_date)').in('lead_id', (leads ?? []).map((l) => l.id));
  const arts = new Map<string, any[]>();
  for (const k of links ?? []) (arts.get(k.lead_id) ?? arts.set(k.lead_id, []).get(k.lead_id)!).push(k.articles);
  const { data: posts } = await db.from('job_posts').select('id, company_id, title, role, posted_at, first_seen_at, status, is_test, companies(name)')
    .eq('status', 'open').not('company_id', 'is', null).eq('is_test', false).limit(5000);

  const by = new Map<string, { name: string; types: Record<string, { date: string; fallback: boolean }[]>; fits: number[] }>();
  const at = (id: string, name: string) => by.get(id) ?? by.set(id, { name, types: {}, fits: [] }).get(id)!;
  let fallbacks = 0, signals = 0;
  for (const l of leads ?? []) {
    if (!l.company_id) continue;
    const src = leadSource(l.source_url);
    const a = (arts.get(l.id) ?? []).find((x: any) => x?.url && l.source_url && String(l.source_url).startsWith(String(x.url).split('#')[0])) ?? (arts.get(l.id) ?? [])[0];
    const real = src === 'tender' ? (a?.award_date ?? a?.published_at) : a?.published_at;
    const date = String(real ?? l.created_at).slice(0, 10);
    const c = at(l.company_id, (l as any).companies?.name ?? '?');
    c.fits.push(l.fit_score);
    if (!within(date)) continue;
    signals++; if (!real) fallbacks++;
    (c.types[src] ??= []).push({ date, fallback: !real });
  }
  const postsBy = new Map<string, any[]>();
  for (const p of posts ?? []) (postsBy.get(p.company_id) ?? postsBy.set(p.company_id, []).get(p.company_id)!).push(p);
  for (const [cid, ps] of postsBy) {
    const c = at(cid, ps[0].companies?.name ?? '?');
    for (const p of ps) {
      const date = String(p.posted_at ?? p.first_seen_at).slice(0, 10);
      if (!within(date)) continue;
      signals++; if (!p.posted_at) fallbacks++;
      (c.types.hiring ??= []).push({ date, fallback: !p.posted_at });
    }
    const roles = new Map<string, any[]>();
    for (const p of ps) { const k = roleKey(p) || 'Trade role'; roles.set(k, [...(roles.get(k) ?? []), p]); }
    for (const [role, list] of roles) {
      const r = reAdverts(list);
      const last = r.days[r.days.length - 1];
      if (r.count >= 1 && within(last)) (c.types[r.boosted ? 'readvert_raised' : 'readvert_once'] ??= []).push({ date: last, fallback: false });
      void role;
    }
  }
  console.log(`signals inside 60 days: ${signals} · dated only by our first sighting: ${fallbacks}`);
  const multi = [...by.values()].map((c) => ({ ...c, kinds: Object.keys(c.types) })).filter((c) => new Set(c.kinds.map((k) => k.startsWith('readvert') ? (k === 'readvert_raised' ? 'readvert' : 'x') : k).filter((k) => k !== 'x')).size >= 2 || c.kinds.length >= 2);
  console.log(`companies with any signal: ${by.size} · with 2+ kinds (counting a once-re-advertised role as its own kind too): ${multi.length}`);
  for (const c of multi) console.log(`  ${c.name}: ${c.kinds.map((k) => `${k}×${c.types[k].length} (${c.types[k].map((s) => s.date + (s.fallback ? '*' : '')).slice(0, 3).join(', ')})`).join(' · ')} · fits ${c.fits.join(',') || '—'}`);
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
