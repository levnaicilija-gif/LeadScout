import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { fetchPage } from '@/lib/fetch-page';
import { extractLead, extractJobPost } from '@/lib/ai/radar-extract';
import { detectEmployerType } from '@/lib/agency-detector';
import { linkedinSearchUrl, googleSearchUrl } from '@/lib/search-urls';
import { RFBT_TRADES, SUPPLY_COUNTRIES } from '@/lib/types';
export const maxDuration = 300;

/** Cron 06:00 CET. Reads sources, fetches unseen links, extracts leads under Stage 1 rules, validates against text, dedups. */
export async function POST(req: Request) {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const { data: sources } = await db.from('sources').select('*').eq('enabled', true).limit(Number(new URL(req.url).searchParams.get('limit') ?? 25));
  const { data: agencies } = await db.from('companies').select('name').eq('employer_type', 'staffing_agency');
  const agencyNames = (agencies ?? []).map((a) => a.name);
  const report: any[] = [];

  for (const src of sources ?? []) {
    try {
      const index = await fetchPage(src.url);
      if (index.status !== 'live') { report.push({ source: src.url, status: 'index not reachable' }); continue; }
      // Candidate article links: same host, look like articles/postings (heuristic; RSS if present is better — TODO per source)
      const links = Array.from(new Set((index.text.match(/https?:\/\/[^\s)]+/g) ?? []).filter((u) => u.startsWith(new URL(src.url).origin)))).slice(0, 15);
      for (const url of links) {
        const { data: seen } = await db.from('articles').select('id').eq('url', url).maybeSingle();
        if (seen) continue;
        const page = await fetchPage(url);
        if (page.status !== 'live' || page.text.length < 400) continue;
        const shotPath = `radar/${Date.now()}-${Math.abs(hash(url))}.png`;
        if (page.screenshot) await db.storage.from('screenshots').upload(shotPath, page.screenshot, { contentType: 'image/png' });
        const { data: article } = await db.from('articles').insert({ source_id: src.id, url, title: page.title, text: page.text, screenshot_path: shotPath, last_fetch_status: 'live', last_fetch_at: page.fetchedAt }).select().single();

        if (src.type === 'job_board' || src.type === 'company_press') {
          const job = await extractJobPost(page.text, url);
          if (job) await upsertJobLead(db, src.workspace_id, job, url, page.text, shotPath, agencyNames);
        }
        const lead = await extractLead(page.text, url);
        if (lead) await upsertWonLead(db, src.workspace_id, lead, article.id, url, page.fetchedAt, agencyNames);
        report.push({ url, lead: !!lead });
      }
      await db.from('sources').update({ last_crawled_at: new Date().toISOString() }).eq('id', src.id);
    } catch (e: any) { report.push({ source: src.url, error: e.message }); }
  }
  return NextResponse.json({ ok: true, report });
}

function fit(trades: string[], location = '', employer: string, timingMonths: number | null) {
  const t = trades.some((x) => RFBT_TRADES.some((r) => x.toLowerCase().includes(r))) ? 1 : 0;
  const g = SUPPLY_COUNTRIES.some((c) => location.toLowerCase().includes(c.toLowerCase())) ? 1 : 0;
  const tm = timingMonths == null ? 0.5 : timingMonths <= 12 ? 1 : 0.3;
  const e = employer === 'end_client' || employer === 'epc_contractor' ? 1 : employer === 'unknown' ? 0.5 : 0.3;
  return Math.round((t * 0.4 + g * 0.2 + tm * 0.25 + e * 0.15) * 100);
}
async function company(db: any, ws: string, name: string, agencyNames: string[]) {
  const { data: existing } = await db.from('companies').select('*').eq('workspace_id', ws).ilike('name', name).maybeSingle();
  if (existing) return existing;
  const det = detectEmployerType(name, agencyNames);
  const { data } = await db.from('companies').insert({ workspace_id: ws, name, employer_type: det.employerType }).select().single();
  return data;
}
async function attachPeople(db: any, leadId: string, ws: string, companyName: string) {
  const { data: ppl } = await db.from('people').select('id').eq('workspace_id', ws).ilike('company_name', `%${companyName.split(' ')[0]}%`).limit(10);
  for (const p of ppl ?? []) await db.from('lead_people').upsert({ lead_id: leadId, person_id: p.id });
}
async function upsertWonLead(db: any, ws: string, x: any, articleId: string, url: string, fetchedAt: string, agencyNames: string[]) {
  const co = await company(db, ws, x.company, agencyNames);
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: dup } = await db.from('leads').select('id').eq('company_id', co.id).eq('kind', 'won_work').gte('created_at', since).ilike('project_name', `%${(x.project?.name ?? '').split(' ').slice(0, 2).join(' ')}%`).maybeSingle();
  let leadId = dup?.id;
  if (!leadId) {
    const { data: lead } = await db.from('leads').insert({ workspace_id: ws, company_id: co.id, kind: 'won_work', project_name: x.project?.name, project_location: x.project?.location, project_value: x.project?.value, phase: x.project?.phase, trades_inferred: x.trades, fit_score: fit(x.trades, x.project?.location, co.employer_type, null), source_url: url, source_fetched_at: fetchedAt }).select().single();
    leadId = lead.id;
    await attachPeople(db, leadId, ws, x.company);
  }
  await db.from('lead_articles').upsert({ lead_id: leadId, article_id: articleId });
  for (const p of x.people) {
    await db.from('contacts').upsert({ lead_id: leadId, company_id: co.id, name: p.name, title: p.title, quote: p.quote, quote_article_id: articleId, linkedin_search_url: linkedinSearchUrl(p.name, x.company), google_search_url: googleSearchUrl(p.name, x.company), email_status: 'unknown' }, { onConflict: 'lead_id,name' as any, ignoreDuplicates: true });
  }
}
async function upsertJobLead(db: any, ws: string, j: any, url: string, pageText: string, shot: string, agencyNames: string[]) {
  const co = await company(db, ws, j.company, agencyNames);
  const { data: lead } = await db.from('leads').upsert({ workspace_id: ws, company_id: co.id, kind: 'job_post', project_name: j.role, project_location: j.location, trades_inferred: j.trades, fit_score: fit(j.trades, j.country ?? j.location, co.employer_type, 3), source_url: url, source_fetched_at: new Date().toISOString() }, { onConflict: 'source_url' as any }).select().single();
  await db.from('job_posts').upsert({ lead_id: lead.id, role: j.role, trades: j.trades, location: j.location, country: j.country, posted_at: j.posted_at, certs_required: j.certs_required, rotation: j.rotation, contract_type: j.contract_type, headcount: j.headcount, source_url: url, screenshot_path: shot, poster_type: co.employer_type }, { onConflict: 'lead_id,source_url' });
  if (j.contact?.name && j.contact?.title) await db.from('contacts').insert({ lead_id: lead.id, company_id: co.id, name: j.contact.name, title: j.contact.title, source_url: url, email: j.contact.email, email_status: j.contact.email ? 'found' : 'unknown', email_source_url: j.contact.email ? url : null, phone: j.contact.phone, phone_source_url: j.contact.phone ? url : null, linkedin_search_url: linkedinSearchUrl(j.contact.name, j.company), google_search_url: googleSearchUrl(j.contact.name, j.company) });
  // hiring pressure: 5+ open posts for the company
  const { count } = await db.from('job_posts').select('id', { count: 'exact', head: true }).in('lead_id', (await db.from('leads').select('id').eq('company_id', co.id).eq('kind', 'job_post')).data?.map((l: any) => l.id) ?? []);
  if ((count ?? 0) >= 5) await db.from('job_posts').update({ hiring_pressure: 'high' }).eq('lead_id', lead.id);
  await attachPeople(db, lead.id, ws, j.company);
}
const hash = (s: string) => s.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
