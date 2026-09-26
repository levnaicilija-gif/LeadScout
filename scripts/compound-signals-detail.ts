/** Read only: every lead and open posting of the named companies, with the dates and the fields the boost would use. */
import { createClient } from '@supabase/supabase-js';
import { isEuropean } from '../src/lib/geo';
import { LEAD_STATE_LEFT, withLeadState } from '../src/lib/workspace-state';
import { probeAdmin } from '../src/lib/test-data';

const names = process.argv.slice(2);
const db = probeAdmin();
(async () => {
  for (const name of names) {
    const { data: cos } = await db.from('companies').select('id, name, country, employer_type, employer_type_source').eq('name', name);
    for (const c of cos ?? []) {
      console.log(`\n${c.name} · ${c.id.slice(0, 8)} · country ${c.country} · ${c.employer_type} (${c.employer_type_source ?? '—'})`);
      const { data: leadRows } = await db.from('leads').select(`id, kind, country, fit_score, source_url, created_at, project_name, lead_articles(articles(url, published_at, award_date)), ${LEAD_STATE_LEFT}`).eq('company_id', c.id);
      // 0049 dropped leads.status; it is read from the workspace's state row and flattened, so the
      // line printed below is unchanged.
      const leads = (leadRows ?? []).map((r) => withLeadState(r as any)) as any[];
      for (const l of leads ?? []) console.log(`  lead ${l.kind} · ${l.status} · ${l.country} (Europe ${isEuropean(l.country)}) · fit ${l.fit_score} · created ${String(l.created_at).slice(0, 10)} · "${String(l.project_name ?? '').slice(0, 60)}" · ${String(l.source_url).slice(0, 70)} · articles ${JSON.stringify((l as any).lead_articles?.map((x: any) => [x.articles?.published_at, x.articles?.award_date]))}`);
      const { data: posts } = await db.from('job_posts').select('status, title, role, country, posted_at, first_seen_at, headcount, via').eq('company_id', c.id);
      for (const p of posts ?? []) console.log(`  post ${p.status} · ${p.role ?? p.title} · ${p.country} · posted ${p.posted_at ?? '—'} · first seen ${String(p.first_seen_at).slice(0, 10)} · headcount ${p.headcount ?? '—'} · via ${p.via}`);
    }
  }
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
