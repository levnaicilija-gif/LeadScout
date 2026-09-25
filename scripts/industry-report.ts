/**
 * Item 18 part 2 and 5: every open lead and Hiring now company through src/lib/industry.ts, counted per category.
 * Read-only. A diagnostic, not a target.
 *
 *   npx tsx --env-file=.env.local scripts/industry-report.ts [--evidence]
 */
import { createClient } from '@supabase/supabase-js';
import { INDUSTRIES, classifyAward, classifyNews, classifyCompany, repeatedSentences, type Classification } from '../src/lib/industry';
import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE } from '../src/lib/workspace-state';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const showEvidence = process.argv.includes('--evidence');

(async () => {
  const { data: ws } = await db.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const W = ws!.id;
  const { data: leads, error } = await db.from('leads').select(`id, project_name, source_url, companies(name), ${LEAD_STATE_EMBED}`).eq('workspace_id', W).eq('kind', 'won_work').eq('is_test', false).not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES);
  if (error) throw new Error(error.message);
  const { data: links } = await db.from('lead_articles').select('lead_id, articles(url, title, text)').in('lead_id', (leads ?? []).map((l) => l.id));
  const arts = new Map<string, any[]>();
  for (const r of links ?? []) (arts.get(r.lead_id) ?? arts.set(r.lead_id, []).get(r.lead_id)!).push((r as any).articles);

  // Sentences a site prints on more than one of its stored stories, from every stored article.
  const stored: { url: string; text: string | null }[] = [];
  for (let from = 0; ; from += 200) {
    const { data, error: aErr } = await db.from('articles').select('url, text').order('id').range(from, from + 199);
    if (aErr) throw new Error(`articles could not be read: ${aErr.message}`);
    if (!data?.length) break; stored.push(...data); if (data.length < 200) break;
  }
  const chrome = repeatedSentences(stored);
  console.log(`site sentences from ${stored.length} stored articles: ${[...chrome.values()].reduce((n, s) => n + s.size, 0)} across ${chrome.size} sites`);

  const rows: { kind: 'news' | 'tender' | 'hiring'; name: string; c: Classification; wordsWouldGive?: string[] }[] = [];
  for (const l of leads ?? []) {
    const tender = (l.source_url ?? '').startsWith('https://ted.europa.eu/');
    const a = arts.get(l.id) ?? [];
    const primary = a.find((x) => x.url === (l.source_url ?? '').split('#')[0]) ?? a[0];
    if (tender) {
      const c = classifyAward(primary?.text ?? '');
      // For comparison only: what the notice's own words would say. Awards are classified by their codes.
      const words = classifyNews({ title: primary?.title, projectName: l.project_name, text: primary?.text, url: primary?.url }, chrome);
      rows.push({ kind: 'tender', name: (l as any).companies?.name, c, wordsWouldGive: words.industries });
    } else {
      rows.push({ kind: 'news', name: (l as any).companies?.name, c: classifyNews({ title: primary?.title, projectName: l.project_name, text: primary?.text, url: primary?.url }, chrome) });
    }
  }
  const { data: posts } = await db.from('job_posts').select('company_id, title, companies!inner(name, employer_type, employer_type_evidence)').eq('status', 'open').eq('is_test', false);
  const byCo = new Map<string, any[]>();
  for (const p of posts ?? []) (byCo.get((p as any).company_id) ?? byCo.set((p as any).company_id, []).get((p as any).company_id)!).push(p);
  for (const ps of byCo.values()) {
    const co = ps[0].companies;
    rows.push({ kind: 'hiring', name: co.name, c: classifyCompany({ postingTitles: ps.map((p) => p.title), employerEvidence: typeof co.employer_type_evidence === 'string' ? co.employer_type_evidence : JSON.stringify(co.employer_type_evidence ?? '') }) });
  }

  const kinds = ['news', 'tender', 'hiring'] as const;
  const total = Object.fromEntries(kinds.map((k) => [k, rows.filter((r) => r.kind === k).length]));
  console.log(`classified: news leads ${total.news} · tender-award leads ${total.tender} · Hiring now companies ${total.hiring}\n`);
  console.log(`${'#'.padStart(2)} ${'category'.padEnd(66)} ${'news'.padStart(10)} ${'tender'.padStart(10)} ${'hiring'.padStart(10)} ${'all'.padStart(10)}`);
  const pct = (n: number, d: number) => `${n} (${d ? Math.round((100 * n) / d) : 0}%)`;
  for (const i of INDUSTRIES) {
    const n = (k: string) => rows.filter((r) => r.kind === k && r.c.industries.includes(i.id)).length;
    const all = rows.filter((r) => r.c.industries.includes(i.id)).length;
    console.log(`${String(i.n).padStart(2)} ${i.label.padEnd(66)} ${pct(n('news'), total.news).padStart(10)} ${pct(n('tender'), total.tender).padStart(10)} ${pct(n('hiring'), total.hiring).padStart(10)} ${pct(all, rows.length).padStart(10)}`);
  }
  // Part 5 — which categories look thin. A flag for a future, deliberately scoped source-addition item, never a
  // prompt to loosen the words: a category with two or fewer items, or under a quarter of the median of the other
  // classified categories, is thin. Other / Uncategorized is not a category to fill.
  const combined = INDUSTRIES.filter((i) => i.id !== 'other').map((i) => ({ i, n: rows.filter((r) => r.c.industries.includes(i.id)).length }));
  const sorted = combined.map((c) => c.n).sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const thin = combined.filter((c) => c.n <= 2 || c.n < median / 4);
  console.log(`\ncoverage (part 5): median of the 16 classified categories ${median} · thin (≤2, or under a quarter of the median): ${thin.length}`);
  for (const c of combined) console.log(`  ${String(c.i.n).padStart(2)} ${c.i.label.padEnd(66)} ${String(c.n).padStart(3)}${thin.includes(c) ? '  THIN — candidate for a scoped source-addition item' : ''}`);

  const multi = rows.filter((r) => r.c.industries.length > 1).length;
  console.log(`\nwith more than one industry: ${multi} of ${rows.length}`);
  const moved = rows.filter((r) => r.kind === 'tender' && r.c.industries[0] === 'other' && r.wordsWouldGive && r.wordsWouldGive[0] !== 'other');
  console.log(`tender awards Other by their codes that their notice words would place (not applied): ${moved.length} — ${JSON.stringify(moved.slice(0, 8).map((r) => `${r.name}: ${r.wordsWouldGive!.join('+')}`))}`);

  if (showEvidence) {
    for (const i of INDUSTRIES) {
      const hits = rows.filter((r) => r.c.industries.includes(i.id));
      if (!hits.length) continue;
      console.log(`\n${i.n}. ${i.label}`);
      for (const r of hits.slice(0, 12)) {
        const ev = r.c.evidence.filter((e) => e.industry === i.id).map((e) => `"${e.term}" (${e.where})`).join('; ');
        console.log(`  ${r.kind} · ${r.name}${ev ? ` · ${ev.slice(0, 140)}` : ''}`);
      }
    }
  }
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
