import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { fetchPage, articleLinks } from '@/lib/fetch-page';
import { browserProvider } from '@/lib/browser';
import { ruleFor } from '@/lib/source-rules';
import { extractLead, extractJobPost } from '@/lib/ai/radar-extract';
import { detectEmployerType } from '@/lib/agency-detector';
import { linkedinSearchUrl, googleSearchUrl } from '@/lib/search-urls';
import { inferTrades, hasRfbtTrades } from '@/lib/trades';
import { countryFromText, regionFor, isEuropean, NON_EUROPE_MAX_FIT } from '@/lib/geo';
export const maxDuration = 300;

/**
 * Cron 06:00 CET. Reads sources, fetches unseen links, extracts leads under Stage 1 rules,
 * validates against text, dedups.
 *
 * Vercel cron issues a GET and sends `Authorization: Bearer <CRON_SECRET>`; a manual run
 * sends `x-cron-secret`. Accept both, on both verbs, or the daily job silently 405s.
 */
const authorised = (req: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('x-cron-secret') === secret || req.headers.get('authorization') === `Bearer ${secret}`;
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const params = new URL(req.url).searchParams;
  let q = db.from('sources').select('*').eq('enabled', true);
  // Which sources this run covers, in order of precedence:
  //
  //   only=<substrings>  an explicit list, for tuning Stage 1 on the sources that matter
  //   tier=priority      the morning crawl — sources Haiku scored 70+
  //   tier=standard      the weekly sweep, which includes anything not yet classified:
  //                      unread is not a reason to ignore a source forever
  //
  // With no parameters it is priority on weekdays and everything on a Sunday, so the weekly
  // sweep rides the same cron rather than costing a second slot.
  const only = params.get('only');
  const tier = only ? `only:${only.slice(0, 60)}` : params.get('tier') ?? (new Date().getUTCDay() === 0 ? 'all' : 'priority');
  if (only) {
    const terms = only.split(',').map((t) => t.trim()).filter(Boolean);
    q = terms.length > 1 ? q.or(terms.map((t) => `url.ilike.%${t}%`).join(',')) : q.ilike('url', `%${terms[0]}%`);
  } else if (tier === 'priority') q = q.eq('tier', 'priority');
  else if (tier === 'standard') q = q.or('tier.eq.standard,tier.is.null');
  const auditOnly = params.get('audit') === '1';
  // Chunking: a Vercel function has 300 s, which is not enough for many sources. Each
  // invocation takes `batch` sources from `cursor`, then hands the next batch to a fresh
  // invocation, so the daily run finishes across several functions instead of timing out.
  const batch = Math.max(1, Number(params.get('batch') ?? 5));
  const cursor = Math.max(0, Number(params.get('cursor') ?? 0));
  const chain = params.get('chain') !== '0';
  const batchesLeft = Number(params.get('batchesLeft') ?? 40);
  const limitParam = params.get('limit');
  // `limit` caps the whole run; a batch never exceeds it.
  const total = limitParam ? Number(limitParam) : undefined;
  const take = total ? Math.min(batch, Math.max(0, total - cursor)) : batch;
  const { data: sources } = take > 0 ? await q.order('id').range(cursor, cursor + take - 1) : { data: [] as any[] };
  const { data: agencies } = await db.from('companies').select('name').eq('employer_type', 'staffing_agency');
  const agencyNames = (agencies ?? []).map((a) => a.name);

  // Hand the next batch to a fresh invocation BEFORE doing this batch's work.
  //
  // It used to be dispatched at the end, which meant a batch that hit the 300 s wall took the
  // whole chain down with it — the 10 September run crawled two sources and stopped. Dispatching
  // first costs nothing and makes the chain independent of whether this batch finishes.
  //
  // The chained request is abandoned on purpose: waiting for it would nest the 300 s budgets.
  const more = (sources ?? []).length === take && take > 0;
  let next: string | null = null;
  if (more && chain && batchesLeft > 1) {
    const u = new URL(req.url);
    u.searchParams.set('cursor', String(cursor + take));
    u.searchParams.set('batch', String(batch));
    u.searchParams.set('batchesLeft', String(batchesLeft - 1));
    next = u.toString();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    await fetch(next, { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET! }, signal: ac.signal }).catch(() => {});
  }

  const report: any[] = [];
  const tally = { sources: 0, sourcesUnreachable: 0, linksFound: 0, alreadySeen: 0, fetchFailed: 0, tooShort: 0, articlesRead: 0, leads: 0, jobLeads: 0, rejected: 0 };
  const rejected: { url: string; why: string }[] = [];
  /** Which sources the free path could read, and which would need a paid browser. */
  const audit: { source: string; via: string; links: number; note?: string }[] = [];

  // Open the run record now, so a batch killed by the 300 s wall still leaves evidence of what
  // it was doing. Without this, "why did this morning produce nothing?" has no answer by lunch.
  const workspaceId = (sources ?? [])[0]?.workspace_id ?? (await db.from('workspaces').select('id').limit(1).maybeSingle()).data?.id ?? null;
  const { data: runRow } = await db.from('radar_runs')
    .insert({ workspace_id: workspaceId, tier, cursor, batch: take })
    .select('id').maybeSingle();

  for (const src of sources ?? []) {
    tally.sources++;
    try {
      const rule = ruleFor(src.url, src.link_rule);
      let index = await fetchPage(rule?.index ?? src.url, rule?.browser ? { force: 'browser' } : {});
      if (index.status !== 'live') {
        tally.sourcesUnreachable++;
        audit.push({ source: src.url, via: index.via, links: 0, note: index.note });
        report.push({ source: src.url, status: 'index not reachable', via: index.via, note: index.note });
        continue;
      }
      let links = articleLinks(index, 15, rule?.pattern);
      // Read fine but nothing article-shaped on it: usually a client-rendered list. Worth one
      // browser attempt before writing the source off.
      if (links.length === 0 && index.via !== 'browser') {
        const rendered = await fetchPage(rule?.index ?? src.url, { force: 'browser' });
        if (rendered.status === 'live') {
          const better = articleLinks(rendered, 15, rule?.pattern);
          if (better.length) { index = rendered; links = better; }
        }
      }
      tally.linksFound += links.length;
      audit.push({ source: src.url, via: index.via, links: links.length, note: rule ? `rule: ${rule.why}` : index.note });
      report.push({ source: src.url, linksFound: links.length, via: index.via });

      // ?audit=1 — index pages only. Answers "which sources can we read for free?" inside the
      // function's 300 s budget; a full crawl of 20 sources cannot fit and times out.
      if (auditOnly) continue;

      for (const url of links) {
       try {
        const { data: seen } = await db.from('articles').select('id').eq('url', url).maybeSingle();
        if (seen) { tally.alreadySeen++; continue; }
        const page = await fetchPage(url);
        if (page.status !== 'live') { tally.fetchFailed++; rejected.push({ url, why: `page did not load — ${page.note ?? 'no reason given'}` }); continue; }
        if (page.text.length < 400) { tally.tooShort++; rejected.push({ url, why: `only ${page.text.length} characters of text — not an article` }); continue; }

        const shotPath = `radar/${Date.now()}-${Math.abs(hash(url))}.png`;
        if (page.screenshot) await db.storage.from('screenshots').upload(shotPath, page.screenshot, { contentType: 'image/png' });
        const { data: article } = await db.from('articles').insert({ source_id: src.id, url, title: page.title, text: page.text, screenshot_path: shotPath, last_fetch_status: 'live', last_fetch_at: page.fetchedAt }).select().single();
        tally.articlesRead++;

        if (src.type === 'job_board' || src.type === 'company_press') {
          const job = await extractJobPost(page.text, url);
          if (job) { await upsertJobLead(db, src.workspace_id, job, url, page.text, shotPath, agencyNames); tally.jobLeads++; }
        }
        const res = await extractLead(page.text, url);
        if (res.ok) {
          await upsertWonLead(db, src.workspace_id, res.lead, article.id, url, page.fetchedAt, agencyNames);
          tally.leads++;
          report.push({ url, title: page.title, lead: true, company: res.lead.company, people: res.lead.people.map((p) => `${p.name} (${p.title})`) });
        } else {
          tally.rejected++;
          rejected.push({ url, why: res.why });
        }
       } catch (e: any) {
        // One unreadable article must not cost us the rest of the source.
        tally.rejected++;
        rejected.push({ url, why: `error: ${String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 300)}` });
       }
      }
      await db.from('sources').update({ last_crawled_at: new Date().toISOString() }).eq('id', src.id);
    } catch (e: any) { report.push({ source: src.url, error: e.message }); }
  }
  if (runRow) {
    await db.from('radar_runs').update({
      finished_at: new Date().toISOString(), tally, rejected, sources_seen: audit,
    }).eq('id', runRow.id);
  }

  // One line per batch, so the daily run is readable in the Vercel logs.
  console.log(`[radar] cursor=${cursor} batch=${take} sources=${tally.sources} articles=${tally.articlesRead} leads=${tally.leads} rejected=${tally.rejected} next=${next ? cursor + take : 'done'}`);

  return NextResponse.json({ ok: true, browser: browserProvider(), cursor, batch: take, nextCursor: more ? cursor + take : null, chained: !!next, tally, audit, rejected, report });
}

/**
 * Fit 0-100: trades x0.4, geography x0.2, timing x0.25, employer type x0.15.
 *
 * Geography is a gate before it is a weight: outside Europe the score is capped at
 * NON_EUROPE_MAX_FIT so a non-European project can never reach Today, however good the trades.
 */
function fit(trades: string[], country: string | undefined, employer: string, timingMonths: number | null) {
  const t = hasRfbtTrades(trades) ? 1 : 0;
  const european = isEuropean(country);
  const g = european ? 1 : 0;
  const tm = timingMonths == null ? 0.5 : timingMonths <= 12 ? 1 : 0.3;
  const e = employer === 'end_client' || employer === 'epc_contractor' ? 1 : employer === 'unknown' ? 0.5 : 0.3;
  const score = Math.round((t * 0.4 + g * 0.2 + tm * 0.25 + e * 0.15) * 100);
  return european ? score : Math.min(score, NON_EUROPE_MAX_FIT);
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
    // Trades from the scope, not just from words the article happened to use.
    const { trades } = inferTrades(x.trades ?? [], x.project?.name, x.project?.phase, x.project?.location, x.company);
    const country = countryFromText(x.project?.location) ?? countryFromText(x.project?.name);
    const { data: lead } = await db.from('leads').insert({ workspace_id: ws, company_id: co.id, kind: 'won_work', project_name: x.project?.name, project_location: x.project?.location, project_value: x.project?.value, phase: x.project?.phase, trades_inferred: trades, country, region: regionFor(country), fit_score: fit(trades, country, co.employer_type, null), source_url: url, source_fetched_at: fetchedAt }).select().single();
    leadId = lead.id;
    await attachPeople(db, leadId, ws, x.company);
  }
  await db.from('lead_articles').upsert({ lead_id: leadId, article_id: articleId });
  for (const p of x.people) {
    // A lead without its quoted decision-maker is not a lead. Never let this fail quietly.
    const { error } = await db.from('contacts').upsert(
      { lead_id: leadId, company_id: co.id, name: p.name, title: p.title, quote: p.quote, quote_article_id: articleId, linkedin_search_url: linkedinSearchUrl(p.name, x.company), google_search_url: googleSearchUrl(p.name, x.company), email_status: 'unknown' },
      { onConflict: 'lead_id,name' as any, ignoreDuplicates: true },
    );
    if (error) throw new Error(`could not save contact "${p.name}" for ${x.company}: ${error.code} ${error.message}`);
  }
}
async function upsertJobLead(db: any, ws: string, j: any, url: string, pageText: string, shot: string, agencyNames: string[]) {
  const co = await company(db, ws, j.company, agencyNames);
  const { trades } = inferTrades(j.trades ?? [], j.role, j.location);
  const country = (j.country && j.country.length === 2 ? j.country.toUpperCase() : undefined) ?? countryFromText(j.country) ?? countryFromText(j.location);
  const { data: lead } = await db.from('leads').upsert({ workspace_id: ws, company_id: co.id, kind: 'job_post', project_name: j.role, project_location: j.location, trades_inferred: trades, country, region: regionFor(country), fit_score: fit(trades, country, co.employer_type, 3), source_url: url, source_fetched_at: new Date().toISOString() }, { onConflict: 'source_url' as any }).select().single();
  await db.from('job_posts').upsert({ lead_id: lead.id, role: j.role, trades: j.trades, location: j.location, country: j.country, posted_at: j.posted_at, certs_required: j.certs_required, rotation: j.rotation, contract_type: j.contract_type, headcount: j.headcount, source_url: url, screenshot_path: shot, poster_type: co.employer_type }, { onConflict: 'lead_id,source_url' });
  if (j.contact?.name && j.contact?.title) await db.from('contacts').insert({ lead_id: lead.id, company_id: co.id, name: j.contact.name, title: j.contact.title, source_url: url, email: j.contact.email, email_status: j.contact.email ? 'found' : 'unknown', email_source_url: j.contact.email ? url : null, phone: j.contact.phone, phone_source_url: j.contact.phone ? url : null, linkedin_search_url: linkedinSearchUrl(j.contact.name, j.company), google_search_url: googleSearchUrl(j.contact.name, j.company) });
  // hiring pressure: 5+ open posts for the company
  const { count } = await db.from('job_posts').select('id', { count: 'exact', head: true }).in('lead_id', (await db.from('leads').select('id').eq('company_id', co.id).eq('kind', 'job_post')).data?.map((l: any) => l.id) ?? []);
  if ((count ?? 0) >= 5) await db.from('job_posts').update({ hiring_pressure: 'high' }).eq('lead_id', lead.id);
  await attachPeople(db, lead.id, ws, j.company);
}
const hash = (s: string) => s.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
