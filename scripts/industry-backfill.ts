/**
 * Item 18 part 2: classify every real lead and every company that has an open lead or an open advert, and store
 * the industries with their evidence (0031). Dry run by default.
 *
 *   npx tsx --env-file=.env.local scripts/industry-backfill.ts [--write]
 *
 * Leads: award notices by their CPV codes, news stories by their words, with the lines a site repeats across its
 * stored stories left out (src/lib/industry.ts). Companies: their advert titles and the quoted words of their
 * employer-type evidence, plus the industries of their open leads, each kept with where it came from.
 * Test rows are never touched. A rerun rewrites the same answer.
 */
import { createClient } from '@supabase/supabase-js';
import { classifyAward, classifyNews, classifyCompany, repeatedSentences, INDUSTRIES, type IndustryEvidence, type IndustryId } from '../src/lib/industry';
import { leadSource } from '../src/lib/lead-source';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const write = process.argv.includes('--write');
const OPEN = (s: string | null) => s !== 'stale' && s !== 'not_for_us';

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>, page = 500): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < page) break;
  }
  return out;
}

(async () => {
  const has0031 = !(await db.from('leads').select('industries').limit(1)).error;
  if (write && !has0031) throw new Error('--write needs migration 0031 (leads.industries, companies.industries)');

  const stored = await all<{ url: string; text: string | null }>((a, b) => db.from('articles').select('url, text').order('id').range(a, b), 200);
  const chrome = repeatedSentences(stored);

  const leads = await all<any>((a, b) => db.from('leads').select('id, company_id, status, kind, project_name, source_url, is_test').eq('is_test', false).order('id').range(a, b));
  const links = await all<any>((a, b) => db.from('lead_articles').select('lead_id, articles(url, title, text)').order('lead_id').range(a, b));
  const arts = new Map<string, any[]>();
  for (const r of links) (arts.get(r.lead_id) ?? arts.set(r.lead_id, []).get(r.lead_id)!).push(r.articles);

  const leadRows: { id: string; company_id: string | null; open: boolean; industries: IndustryId[]; evidence: IndustryEvidence[] }[] = [];
  for (const l of leads) {
    const a = arts.get(l.id) ?? [];
    const primary = a.find((x) => x?.url === (l.source_url ?? '').split('#')[0]) ?? a[0];
    const c = leadSource(l.source_url) === 'tender'
      ? classifyAward(primary?.text ?? '')
      : classifyNews({ title: primary?.title, projectName: l.project_name, text: primary?.text, url: primary?.url }, chrome);
    leadRows.push({ id: l.id, company_id: l.company_id, open: OPEN(l.status), industries: c.industries, evidence: c.evidence });
  }

  const posts = await all<any>((a, b) => db.from('job_posts').select('company_id, title').eq('status', 'open').eq('is_test', false).order('id').range(a, b));
  const titlesBy = new Map<string, string[]>();
  for (const p of posts) if (p.company_id) (titlesBy.get(p.company_id) ?? titlesBy.set(p.company_id, []).get(p.company_id)!).push(p.title);
  const companyIds = [...new Set([...titlesBy.keys(), ...leadRows.filter((l) => l.open && l.company_id).map((l) => l.company_id!)])];
  const companies: any[] = [];
  for (let i = 0; i < companyIds.length; i += 200) {
    const { data, error } = await db.from('companies').select('id, name, employer_type_evidence, is_test').in('id', companyIds.slice(i, i + 200));
    if (error) throw new Error(error.message);
    companies.push(...(data ?? []).filter((c: any) => !c.is_test));
  }
  const companyRows = companies.map((co) => {
    const own = classifyCompany({ postingTitles: titlesBy.get(co.id) ?? [], employerEvidence: typeof co.employer_type_evidence === 'string' ? co.employer_type_evidence : JSON.stringify(co.employer_type_evidence ?? '') });
    const evidence: IndustryEvidence[] = [...own.evidence];
    for (const l of leadRows.filter((x) => x.company_id === co.id && x.open)) {
      for (const e of l.evidence) evidence.push({ ...e, where: `open lead — ${e.where}` });
    }
    const industries = INDUSTRIES.map((i) => i.id).filter((id) => id !== 'other' && evidence.some((e) => e.industry === id)) as IndustryId[];
    return { id: co.id, name: co.name, industries: industries.length ? industries : (['other'] as IndustryId[]), evidence };
  });

  const count = (rows: { industries: IndustryId[] }[]) => Object.fromEntries(INDUSTRIES.map((i) => [i.id, rows.filter((r) => r.industries.includes(i.id)).length]).filter(([, n]) => n));
  console.log(`leads ${leadRows.length} (open ${leadRows.filter((l) => l.open).length}) · companies ${companyRows.length} · site sentences from ${stored.length} articles`);
  console.log('leads by industry:', JSON.stringify(count(leadRows)));
  console.log('companies by industry:', JSON.stringify(count(companyRows)));
  if (!write) { console.log(`\ndry run — nothing written.${has0031 ? '' : ' 0031 is not applied yet.'} Add --write to store.`); return; }

  const now = new Date().toISOString();
  let leadsWritten = 0, companiesWritten = 0;
  const failures: string[] = [];
  const pool = async <T,>(items: T[], fn: (t: T) => Promise<void>) => {
    const q = [...items];
    await Promise.all(Array.from({ length: 8 }, async () => { for (let it = q.shift(); it; it = q.shift()) await fn(it); }));
  };
  await pool(leadRows, async (l) => {
    const { error } = await db.from('leads').update({ industries: l.industries, industry_evidence: l.evidence, industries_at: now }).eq('id', l.id).eq('is_test', false);
    if (error) failures.push(`lead ${l.id}: ${error.message}`); else leadsWritten++;
  });
  await pool(companyRows, async (c) => {
    const { error } = await db.from('companies').update({ industries: c.industries, industry_evidence: c.evidence, industries_at: now }).eq('id', c.id);
    if (error) failures.push(`company ${c.name}: ${error.message}`); else companiesWritten++;
  });
  console.log(`\nwritten: ${leadsWritten} of ${leadRows.length} leads, ${companiesWritten} of ${companyRows.length} companies`);
  if (failures.length) { console.log(`failures (${failures.length}) — rerun to finish:\n  ${failures.slice(0, 5).join('\n  ')}`); process.exit(1); }
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
