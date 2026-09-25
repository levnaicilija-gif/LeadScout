/**
 * Queue item 17: what the lead-age thresholds do to what is in the database today. Read-only.
 *
 *   npx tsx --env-file=.env.local scripts/lead-age-report.ts
 *
 * Award dates are read back from each notice's stored text, so the numbers do not wait on the
 * migration that gives them a column. Nothing is written and no status is touched.
 */
import { createClient } from '@supabase/supabase-js';
import { newsLeadAge, tenderLeadAge, postingAge, reAdverts, roleKey, AGE_RULES, REPOST_WINDOW_DAYS, REPOSTS_TO_BOOST, type Age, type AgeState } from '../src/lib/lead-age';
import { leadSource, primaryArticle } from '../src/lib/lead-source';
import { awardDateFromText } from '../src/lib/tender/award';
import { COMPANY_STATE_LEFT, LEAD_STATE_EMBED, withCompanyState, withLeadState } from '../src/lib/workspace-state';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const STATES: AgeState[] = ['fresh', 'flagged', 'stale', 'unknown'];

async function all<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: any }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
}

const line = (label: string, ages: Age[]) => {
  const n = (s: AgeState) => ages.filter((a) => a.state === s).length;
  console.log(`  ${label.padEnd(40)} ${String(ages.length).padStart(4)}   ${STATES.map((s) => `${s} ${n(s)}`).join(' · ')}`);
};
const count = <T>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {});

(async () => {
  const now = new Date();
  console.log(`LEAD AGE as of ${now.toISOString().slice(0, 10)} · news flag ${AGE_RULES.news.flagDays} / stale ${AGE_RULES.news.staleDays} · award flag ${AGE_RULES.tender.flagDays} / stale ${AGE_RULES.tender.staleDays} · posting flag ${AGE_RULES.posting.flagDays} · raised at ${REPOSTS_TO_BOOST}+ re-adverts in ${REPOST_WINDOW_DAYS} days`);

  // ------------------------------------------------------------------ won-work leads
  const leads = await all<any>((f) => db.from('leads')
    .select(`id, source_url, project_name, companies(name), lead_articles(articles(url, published_at, text)), ${LEAD_STATE_EMBED}`)
    .eq('kind', 'won_work').eq('is_test', false).range(f, f + 999));
  const rows = leads.map(withLeadState).map((l) => {
    const a: any = primaryArticle(l.lead_articles, l.source_url);
    const src = leadSource(l.source_url);
    const award = src === 'tender' ? awardDateFromText(String(a?.text ?? '')) : null;
    const age = src === 'tender'
      ? tenderLeadAge({ awardDate: award?.date, awardBasis: award?.which, publishedAt: a?.published_at }, now)
      : newsLeadAge({ publishedAt: a?.published_at }, now);
    return { l, src, age };
  });
  const surfaced = (r: (typeof rows)[number]) => !['stale', 'not_for_us'].includes(r.l.status);

  console.log('\nWON-WORK LEADS                                   total   by age');
  line('News — on the Leads screen', rows.filter((r) => surfaced(r) && r.src === 'news').map((r) => r.age));
  line('Tender award — on the Leads screen', rows.filter((r) => surfaced(r) && r.src === 'tender').map((r) => r.age));
  line('News — already hidden by status', rows.filter((r) => !surfaced(r) && r.src === 'news').map((r) => r.age));
  line('Tender award — already hidden by status', rows.filter((r) => !surfaced(r) && r.src === 'tender').map((r) => r.age));
  console.log(`  tender leads measured from: ${JSON.stringify(count(rows.filter((r) => r.src === 'tender'), (r) => r.age.basis ?? 'no date'))}`);

  const list = (title: string, rs: typeof rows) => {
    console.log(`\n${title}: ${rs.length}`);
    for (const r of rs.sort((a, b) => (b.age.days ?? -1) - (a.age.days ?? -1))) {
      console.log(`  [${r.age.state}] ${r.l.companies?.name} — ${r.l.project_name ?? '(no project name)'} · status ${r.l.status} · ${r.age.why}`);
    }
  };
  list('NEWS LEADS flagged, stale or age unknown', rows.filter((r) => r.src === 'news' && r.age.state !== 'fresh'));
  list('TENDER LEADS flagged or stale', rows.filter((r) => r.src === 'tender' && (r.age.state === 'flagged' || r.age.state === 'stale')));

  // ------------------------------------------------------------------ hiring now
  const posts = await all<any>((f) => db.from('job_posts')
    // 0049 moved the override and the hiring status to workspace_company_state, nested inside the
    // company embed here and flattened below, so `p.companies.hiring_status` still reads.
    .select(`id, company_id, role, title, location, posted_at, first_seen_at, duplicate_of, companies!inner(name, employer_type, ${COMPANY_STATE_LEFT})`)
    .eq('status', 'open').not('company_id', 'is', null).eq('is_test', false).range(f, f + 999));
  const withState = posts.map((p: any) => (p.companies ? { ...p, companies: withCompanyState(p.companies) } : p));
  const live = withState.filter((p) => !p.duplicate_of && p.companies?.hiring_status !== 'not_for_us');
  const agency = (p: any) => (p.companies?.employer_type_override ?? p.companies?.employer_type) === 'staffing_agency';

  console.log('\nHIRING NOW                                       total   by age');
  line('Postings (open, not duplicates, not "not for us")', live.map((p) => postingAge(p, now)));
  console.log(`  postings measured from: ${JSON.stringify(count(live.map((p) => postingAge(p, now)), (a) => (a.basis ?? 'no date').split(' (')[0]))}`);

  // A row is one company; its age is its newest advert's.
  const byCompany = new Map<string, any[]>();
  for (const p of live) byCompany.set(p.company_id, [...(byCompany.get(p.company_id) ?? []), p]);
  const rowAge = (ps: any[]) => ps.map((p) => ({ p, age: postingAge(p, now) })).sort((a, b) => (a.age.days ?? Infinity) - (b.age.days ?? Infinity))[0].age;
  const companies = [...byCompany.values()];
  line('Company rows — default view (agencies hidden)', companies.filter((ps) => !agency(ps[0])).map(rowAge));
  line('Company rows — with agencies shown', companies.map(rowAge));

  // Re-adverts per company and role.
  const roles = new Map<string, any[]>();
  for (const p of live) { const k = `${p.companies?.name} | ${roleKey(p) || 'Trade role'}`; roles.set(k, [...(roles.get(k) ?? []), p]); }
  const readverts = [...roles.entries()].map(([k, ps]) => ({ k, ps, r: reAdverts(ps, now) }));
  const multi = readverts.filter((x) => x.ps.length > 1);
  console.log(`\nRE-ADVERTS (same company, same role, different days, inside ${REPOST_WINDOW_DAYS} days)`);
  console.log(`  roles with more than one advert: ${multi.length} — the current "reposted" wording counts all of these`);
  for (const x of multi) console.log(`    ${x.k}: ${x.ps.length} adverts on ${x.r.days.length} day(s) → re-advertised ${x.r.count}×${x.r.boosted ? ' — RAISED' : ''} (${x.r.days.join(', ') || 'no dates'})`);
  const raisedRoles = readverts.filter((x) => x.r.boosted);
  const raisedRows = new Set(raisedRoles.map((x) => x.ps[0].company_id));
  console.log(`  roles raised (${REPOSTS_TO_BOOST}+ re-adverts): ${raisedRoles.length} · company rows raised: ${raisedRows.size} · roles re-advertised exactly once: ${readverts.filter((x) => x.r.count === 1).length}`);
})().catch((e) => { console.error(e); process.exit(1); });
