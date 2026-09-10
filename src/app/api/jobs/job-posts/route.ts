import { NextResponse } from 'next/server';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import { supabaseAdmin } from '@/lib/supabase/server';
import { httpGet, httpPost } from '@/lib/http';
import { fetchPage } from '@/lib/fetch-page';
import { atsListUrl, parseAtsJobs, fetchWorkday, type AtsJob, type AtsType } from '@/lib/ats';
import { claude, MODEL_CLASSIFY, MODEL_EXTRACT } from '@/lib/ai/claude';
import { logModelCall, Budget, DAILY_BUDGET_EUR } from '@/lib/cost';
import { inferTrades } from '@/lib/trades';
import { countryFromText, regionFor } from '@/lib/geo';
import { z } from 'zod';
export const maxDuration = 300;

/**
 * Read each company's own board and keep the postings that are for trades we place.
 *
 * Three things keep this affordable enough to run every day:
 *
 *   fingerprint  a board whose contents hash the same as yesterday is not read again
 *   titles first Haiku judges every title for a few hundredths of a cent; only the ones it
 *                keeps cost a Sonnet call on the body
 *   a budget     the run stops at the daily cap rather than quietly spending past it
 *
 * A posting is stored against the company, not a lead: a lead is something a recruiter decides
 * to create.
 *
 *   POST /api/jobs/job-posts?batch=12&cap=2
 */
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

const fingerprint = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

const TitleVerdicts = z.object({
  keep: z.array(z.number()).nullish().transform((v) => v ?? []),
});

const TITLE_SYSTEM = `You are filtering job titles for RFBT, which supplies skilled trades to industry.

RFBT places: welders, pipefitters, platers, plate workers, blasters, painters, coating inspectors, NDT technicians, scaffolders, riggers, rope access technicians, electricians, mechanical fitters, wind turbine technicians, marine crew, HVAC and insulation trades, and the supervisors and QA/QC inspectors directly over them.

Return the indexes of the titles that are one of those, or a direct supervisor of them.

NOT wanted: office, sales, marketing, finance, HR, legal, IT, software, data, design, procurement, management consultancy, graduate schemes, internships, apprenticeships, or engineering roles that are desk-based design rather than site trades.

Return {"keep":[0,3,7]} — indexes only, empty when none qualify.`;

const JobDetail = z.object({
  role: z.string().nullish().transform((v) => v ?? undefined),
  trades: z.array(z.string()).nullish().transform((v) => v ?? []),
  location: z.string().nullish().transform((v) => v ?? undefined),
  country: z.string().nullish().transform((v) => v ?? undefined),
  certs_required: z.array(z.string()).nullish().transform((v) => v ?? []),
  rotation: z.string().nullish().transform((v) => v ?? undefined),
  contract_type: z.string().nullish().transform((v) => v ?? undefined),
  headcount: z.number().nullish().transform((v) => v ?? undefined),
  start: z.string().nullish().transform((v) => v ?? undefined),
});

/**
 * Job links on a careers page we could not read as JSON.
 *
 * Two tests, because boards do not agree on a URL shape. Either the path says what it is —
 * /jobs/, /stillinger/, /vacatures/ — or it sits one level below the careers page itself and
 * looks like an item rather than another section: /career/hydraulic-technician-offshore.
 * The first pass alone missed Aibel, Vard, DOF and most of the Nordic boards.
 */
function jobLinksFrom(html: string, base: string): AtsJob[] {
  const $ = cheerio.load(html);
  const out: AtsJob[] = [];
  const seen = new Set<string>();

  let root = '';
  try { const b = new URL(base); root = b.pathname.replace(/\/+$/, ''); } catch { /* base is not a URL */ }
  const SAYS_JOB = /\/(job|jobs|vacancy|vacancies|vacature|vacatures|stilling|stillinger|ledige|stelle|stellen|offre|offres|position|positions|opening|openings|karriere|career|careers|jobb|lediga|praca|empleo|o|j)\//i;

  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href') ?? '';
    const title = $(el).text().replace(/\s+/g, ' ').trim();
    if (title.length < 4 || title.length > 140) return;
    // Navigation, not a posting.
    if (/^(apply|read more|les mer|se stilling|more|search|filter|all jobs|alle)$/i.test(title)) return;
    let u: URL;
    try { u = new URL(raw, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;

    const path = u.pathname.replace(/\/+$/, '');
    const seg = path.split('/').filter(Boolean);
    const last = seg[seg.length - 1] ?? '';
    // An item page: a slug of real words, or an id, not a one-word section.
    const looksLikeItem = seg.length > 0 && (/[-_]/.test(last) || /\d{2,}/.test(last)) && last.length > 6;
    const underCareers = !!root && path.startsWith(root) && path !== root;

    if (!(SAYS_JOB.test(u.pathname) && looksLikeItem) && !(underCareers && looksLikeItem)) return;

    u.hash = ''; u.search = '';
    const href = u.toString();
    if (seen.has(href)) return;
    seen.add(href);
    out.push({ title, url: href });
  });
  return out.slice(0, 60);
}

async function boardFor(c: any): Promise<{ jobs: AtsJob[]; via: string; raw: string } | null> {
  if (c.ats_type === 'workday' && c.ats_slug) {
    const jobs = await fetchWorkday(c.ats_slug, async (u, body) => {
      const r = await httpPost(u, body, { 'content-type': 'application/json', accept: 'application/json' }, 20000);
      return { ok: r.ok, body: r.body };
    });
    if (jobs.length) return { jobs, via: 'ats', raw: jobs.map((j) => j.url).join('\n') };
  }
  if (c.ats_type && c.ats_slug) {
    const list = atsListUrl(c.ats_type as AtsType, c.ats_slug);
    if (list) {
      const r = await httpGet(list, { headers: { accept: 'application/json,application/xml,text/xml' } }, 20000);
      if (r.ok) {
        const jobs = parseAtsJobs(c.ats_type as AtsType, c.ats_slug, r.body);
        if (jobs.length) return { jobs, via: 'ats', raw: r.body };
      }
    }
  }
  if (!c.careers_url) return null;
  const r = await httpGet(c.careers_url, {}, 20000);
  if (r.ok && r.body) {
    const jobs = jobLinksFrom(r.body, c.careers_url);
    if (jobs.length) return { jobs, via: 'http', raw: r.body };
  }
  // Nothing in the HTML: the list is very likely rendered in the browser. Worth one attempt —
  // this is where most Nordic careers pages actually keep their vacancies.
  const rendered = await fetchPage(c.careers_url, { force: 'browser' });
  if (rendered.status !== 'live') return null;
  const asHtml = rendered.links
    .map((l) => `<a href="${l}">${decodeURIComponent(l.split('/').filter(Boolean).pop() ?? '').replace(/[-_]+/g, ' ')}</a>`)
    .join('');
  const jobs = jobLinksFrom(asHtml, c.careers_url);
  return jobs.length ? { jobs, via: 'browser', raw: rendered.links.join('\n') } : null;
}

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const batch = Math.max(1, Number(p.get('batch') ?? 12));
  const cap = Number(p.get('cap') ?? DAILY_BUDGET_EUR);
  const only = p.get('only');
  const chain = p.get('chain') !== '0';
  const batchesLeft = Number(p.get('batchesLeft') ?? 20);

  const { data: ws } = await db.from('workspaces').select('id').limit(1).maybeSingle();
  if (!ws) return NextResponse.json({ error: 'no workspace' }, { status: 400 });
  const budget = await Budget.open(db, ws.id, cap);
  if (budget.exhausted) {
    return NextResponse.json({ ok: true, stopped: 'daily budget already spent', spentToday: budget.totalToday.toFixed(2), cap });
  }

  // Companies with a board, least recently crawled first.
  let q = db.from('companies')
    .select('id, name, domain, country, careers_url, ats_type, ats_slug, careers_needs_browser, careers_fingerprint, employer_type')
    .eq('careers_status', 'found').neq('employer_type', 'staffing_agency')
    .order('last_jobs_crawl_at', { ascending: true, nullsFirst: true }).limit(batch);
  if (only) q = q.ilike('name', `%${only}%`);
  const { data: companies, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const stats = { companies: 0, unchanged: 0, noBoard: 0, titlesSeen: 0, tradeTitles: 0, postsWritten: 0, detailed: 0 };
  const found: any[] = [];

  for (const c of companies ?? []) {
    if (budget.exhausted) break;
    stats.companies++;
    try {
      const board = await boardFor(c);
      if (!board) {
        stats.noBoard++;
        await db.from('companies').update({ last_jobs_crawl_at: new Date().toISOString(), jobs_crawl_status: 'no board' }).eq('id', c.id);
        continue;
      }

      // Unchanged board: nothing new to read, and nothing to pay for.
      const fp = fingerprint(board.jobs.map((j) => `${j.title}|${j.url}`).join('\n'));
      if (fp === c.careers_fingerprint) {
        stats.unchanged++;
        await db.from('companies').update({ last_jobs_crawl_at: new Date().toISOString(), jobs_crawl_status: 'unchanged' }).eq('id', c.id);
        // The postings are still open even though we did not re-read them.
        await db.from('job_posts').update({ last_seen_at: new Date().toISOString() }).eq('company_id', c.id).eq('status', 'open');
        continue;
      }

      stats.titlesSeen += board.jobs.length;

      // Titles first: one cheap call for the whole board.
      const ai = await claude.messages.create({
        model: MODEL_CLASSIFY, max_tokens: 500, system: TITLE_SYSTEM,
        messages: [{ role: 'user', content: board.jobs.map((j, i) => `${i}: ${j.title}${j.location ? ` — ${j.location}` : ''}`).join('\n') }],
      });
      budget.add(await logModelCall(db, ws.id, MODEL_CLASSIFY, `job titles ${c.name}`, ai.usage));
      const text = ai.content.filter((x) => x.type === 'text').map((x: any) => x.text).join('');
      const keep = TitleVerdicts.parse(JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}')).keep
        .filter((i) => Number.isInteger(i) && i >= 0 && i < board.jobs.length);
      stats.tradeTitles += keep.length;

      const seenUrls: string[] = [];
      for (const idx of keep) {
        const j = board.jobs[idx];
        seenUrls.push(j.url);
        const trades = inferTrades([], j.title, j.location).trades;
        const country = countryFromText(j.location) ?? c.country ?? undefined;

        const row: any = {
          company_id: c.id, source_url: j.url, title: j.title, role: j.title,
          location: j.location ?? null, country: country ?? null, trades,
          posted_at: j.postedAt ? String(j.postedAt).slice(0, 10) : null,
          via: board.via, is_trade: true, classified_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(), status: 'open',
          poster_type: c.employer_type ?? 'unknown',
        };

        // The body is worth a Sonnet call only for a posting we are keeping, and only while
        // there is budget left. Without it the row is still useful — title, place, link.
        const body = j.description;
        if (body && body.length > 200 && !budget.exhausted) {
          try {
            const detail = await claude.messages.create({
              model: MODEL_EXTRACT, max_tokens: 700,
              system: `Read this job posting and copy what it states. Return JSON with exactly these keys: {"role","trades","location","country","certs_required","rotation","contract_type","headcount","start"}. country is ISO-3166 alpha-2. Omit any key the posting does not state — never guess one. No prose.`,
              messages: [{ role: 'user', content: `${j.title}\n\n${body}` }],
            });
            budget.add(await logModelCall(db, ws.id, MODEL_EXTRACT, `job body ${j.title.slice(0, 40)}`, detail.usage));
            const dt = detail.content.filter((x) => x.type === 'text').map((x: any) => x.text).join('');
            const d = JobDetail.parse(JSON.parse(dt.match(/\{[\s\S]*\}/)?.[0] ?? '{}'));
            Object.assign(row, {
              role: d.role ?? row.role,
              trades: d.trades.length ? inferTrades(d.trades, j.title, d.location ?? j.location).trades : row.trades,
              location: d.location ?? row.location,
              country: (d.country && d.country.length === 2 ? d.country.toUpperCase() : countryFromText(d.country)) ?? row.country,
              certs_required: d.certs_required, rotation: d.rotation ?? null,
              contract_type: d.contract_type ?? null, headcount: d.headcount ?? null,
              description: body.slice(0, 4000),
            });
            stats.detailed++;
          } catch { /* the title-level row still stands */ }
        }

        const { error: up } = await db.from('job_posts').upsert(row, { onConflict: 'company_id,source_url' });
        if (!up) { stats.postsWritten++; found.push({ company: c.name, title: row.role, location: row.location, country: row.country, via: board.via }); }
      }

      // Anything previously open on this board and not on it now has been filled or pulled.
      if (seenUrls.length) {
        await db.from('job_posts').update({ status: 'closed' })
          .eq('company_id', c.id).eq('status', 'open').not('source_url', 'in', `(${seenUrls.map((u) => `"${u}"`).join(',')})`);
      }

      await db.from('companies').update({
        careers_fingerprint: fp, last_jobs_crawl_at: new Date().toISOString(),
        jobs_crawl_status: `${keep.length} of ${board.jobs.length} kept`,
      }).eq('id', c.id);
    } catch (e: any) {
      await db.from('companies').update({ last_jobs_crawl_at: new Date().toISOString(), jobs_crawl_status: `error: ${String(e?.message ?? e).slice(0, 80)}` }).eq('id', c.id);
    }
  }

  let chained = false;
  if (chain && !only && !budget.exhausted && (companies ?? []).length === batch && batchesLeft > 1) {
    const u = new URL(req.url);
    u.searchParams.set('batchesLeft', String(batchesLeft - 1));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    await fetch(u.toString(), { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET! }, signal: ac.signal }).catch(() => {});
    chained = true;
  }

  console.log(`[job-posts] companies=${stats.companies} titles=${stats.titlesSeen} trade=${stats.tradeTitles} written=${stats.postsWritten} spent=EUR${budget.totalToday.toFixed(2)}`);
  return NextResponse.json({
    ok: true, stats, chained,
    spentToday: Number(budget.totalToday.toFixed(4)), cap, budgetLeft: Number(budget.remaining.toFixed(4)),
    found: found.slice(0, 40),
  });
}
