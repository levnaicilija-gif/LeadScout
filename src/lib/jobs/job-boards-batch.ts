import { NextResponse } from 'next/server';
import { cronAuthorised } from '@/lib/jobs/cron-auth';
import { supabaseAdmin } from '@/lib/supabase/server';
import { crawlWorkspace } from '@/lib/crawl-workspace';
import { COMPANY_STATE_LEFT, withCompanyState } from '@/lib/workspace-state';
import { fetchPage, articleLinks } from '@/lib/fetch-page';
import { ruleFor } from '@/lib/source-rules';
import { claude, MODEL_CLASSIFY, MODEL_EXTRACT, appearsIn } from '@/lib/ai/claude';
import { logModelCall, Budget, DAILY_BUDGET_EUR } from '@/lib/cost';
import { inferTrades } from '@/lib/trades';
import { countryFromJobLocation, isEuropean } from '@/lib/geo';
import { detectEmployerType } from '@/lib/agency-detector';
import { findOrCreateCompany } from '@/lib/find-or-create-company';
import { refreshCompanyIndustries } from '@/lib/industry-store';
import { hasJobBoardFields } from '@/lib/schema-features';
import { cleanTitle } from '@/lib/job-title';
import { z } from 'zod';

/**
 * Job boards — the secondary source.
 *
 * A company's own careers page is the primary signal: it is unambiguous about who is hiring and
 * how many. A board is worth reading second, for the employers whose sites we cannot get at and
 * for the market view. It is second and not first for two reasons:
 *
 *   the same vacancy appears three times, placed by agencies competing for one fee
 *   the advert often names nobody — "a leading offshore contractor" is not a company
 *
 * So the poster and the employer are recorded separately, and never merged. Where the employer
 * is not named, the posting is kept with company_id null rather than attached to the agency that
 * placed it: an agency advert filed as a company's hiring is how a competitor becomes a lead.
 *
 *   POST /api/jobs/job-boards?batch=4&cap=2
 */

const Posting = z.object({
  is_trade_vacancy: z.boolean().nullish().transform((v) => v ?? false),
  role: z.string().nullish().transform((v) => v ?? undefined),
  trades: z.array(z.string()).nullish().transform((v) => v ?? []),
  /** The company the work is FOR, only when the advert names it. */
  employer: z.string().nullish().transform((v) => v ?? undefined),
  /** Who placed the advert — an agency, or the employer itself. */
  poster: z.string().nullish().transform((v) => v ?? undefined),
  poster_is_agency: z.boolean().nullish().transform((v) => (v === null ? undefined : v)),
  location: z.string().nullish().transform((v) => v ?? undefined),
  country: z.string().nullish().transform((v) => v ?? undefined),
  certs_required: z.array(z.string()).nullish().transform((v) => v ?? []),
  rotation: z.string().nullish().transform((v) => v ?? undefined),
  contract_type: z.string().nullish().transform((v) => v ?? undefined),
  headcount: z.number().nullish().transform((v) => v ?? undefined),
  posted_at: z.string().nullish().transform((v) => v ?? undefined),
});

const POSTING_SYSTEM = `You are reading one job advert from a jobs board for RFBT, which supplies skilled trades to industry.

RFBT's trades, and the only words allowed in "trades":
welder, painter, blaster, pipefitter, fitter, ndt, rope access, wind technician, electrician, scaffolder

THE TWO COMPANIES. A board advert usually involves two, and they must not be merged:
- "poster" is whoever placed the advert — the agency or the company, whichever the page presents as the advertiser.
- "employer" is the company the work is actually FOR. Copy it ONLY if the advert names it outright. "A leading offshore contractor", "our client, a major EPC" and "a well-known shipyard" name nobody: omit employer entirely rather than guessing from the sector or the location.

poster_is_agency is true when the advertiser is a staffing, recruitment, manpower or crewing business.

is_trade_vacancy is false for office, sales, finance, HR, IT, software, design or desk-based engineering roles, and for anything that is not an actual vacancy — a category page, a search result list, an agency's "register with us" page.

Copy dates, certificates, rotation and headcount exactly as printed; omit anything the advert does not state. Never invent a company name, a certificate or a number.`;

/** One job-board batch. The daily run is the tick's: src/lib/jobs/tick.ts. */
export async function runJobBoardsBatch(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const batch = Math.max(1, Number(p.get('batch') ?? 4));
  const perBoard = Math.max(1, Number(p.get('perBoard') ?? 12));
  const cap = Number(p.get('cap') ?? DAILY_BUDGET_EUR);
  const only = p.get('only');

  if (!(await hasJobBoardFields(db))) {
    return NextResponse.json({ ok: true, skipped: 'migration 0014 has not been applied yet' });
  }

  // Named, never "the first workspace": with two workspaces an unordered limit(1) could file this job's work under either.
  const ws = await crawlWorkspace(db).then((id) => ({ id, error: '' }), (e: Error) => ({ id: '', error: e.message }));
  if (!ws.id) return NextResponse.json({ error: ws.error }, { status: 500 });
  const budget = await Budget.open(db, cap);
  if (budget.exhausted) return NextResponse.json({ ok: true, stopped: 'daily budget already spent', spentToday: Number(budget.totalToday.toFixed(4)) });

  // Only boards worth the money: the tier Haiku scored, least recently crawled first.
  let q = db.from('sources').select('id, name, url, link_rule, workspace_id')
    .eq('type', 'job_board').eq('enabled', true)
    .order('last_crawled_at', { ascending: true, nullsFirst: true }).limit(batch);
  if (only) q = q.ilike('url', `%${only}%`);
  const { data: boards, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // NOTHING IS HANDED ON. This used to dispatch the next batch to its own deployment before doing any
  // work, which is the shape Vercel refuses with 508 INFINITE_LOOP_DETECTED after a few hops — a
  // function calling its own deployment is capped however it is timed (2026-09-14). The tick runs the
  // next batch itself, after this one has written its rows, exactly as it does for radar, discovery
  // and job-posts. `chained` is kept in the response, always false, so a caller reading the old shape
  // sees a truthful answer rather than a missing field.
  const chained = false;

  // Companies we already know, so an advert can be matched to one rather than creating a new row.
  // Item 20 step 2b: the override is this workspace's own correction, read from its state row and
  // flattened so the agency test below is unchanged. LEFT join and pinned to this workspace: only 3
  // companies of 5,889 carry an override, so an inner join would reduce `known` from the whole book
  // of companies to three — and this map is what stops an advert creating a duplicate company row.
  const { data: knownRaw } = await db.from('companies')
    // The old column is NOT named here. Every company carrying an override has a state row (3 of 3,
    // checked 2026-09-24), so the column adds nothing — and naming it would leave a reference to a
    // column 2c removes inside a TEMPLATE LITERAL, which column-exists-check cannot read. 2b put
    // this select into that blind spot; this takes it back out.
    .select(`id, name, employer_type, ${COMPANY_STATE_LEFT}`)
    .eq('workspace_id', ws.id);
  const known = (knownRaw ?? []).map(withCompanyState);
  const byName = new Map(known.map((c: any) => [canon(c.name), c]));
  const agencyNames = known.filter((c: any) => (c.employer_type_override ?? c.employer_type) === 'staffing_agency').map((c: any) => c.name);

  const stats = { boards: 0, linksSeen: 0, alreadyHad: 0, read: 0, notTrade: 0, kept: 0, agencyPosted: 0, employerNamed: 0, outsideEurope: 0, secondary: 0, noTitle: 0, classified: 0 };
  // ITEM 20: A POSTING WRITTEN HERE USED TO LEAVE ITS COMPANY UNCLASSIFIED, AND FROM 0053 THAT IS A
  // VISIBILITY HOLE RATHER THAN A TIDINESS ONE. The careers/ATS crawl classifies the company right after
  // it writes postings (job-posts-batch.ts:372) — this path, item 4's board crawl, never did, and it is
  // the only other writer of job_posts. can_see_industries() treats an EMPTY industries array as visible
  // to everyone (the owner's decision that an unclassified row is never hidden), and read_job_posts asks
  // whether the posting's COMPANY is visible, so a board-sourced advert on an unclassified company shows
  // that company and its posting to every capped account. Measured 2026-09-26: 0 of 5,651 unclassified
  // companies currently hold an open posting, and via='board' rows are still 0 of 87, so this is the gap
  // being closed BEFORE it is first exercised rather than after.
  //
  // Collected per company and run after the loop, not per posting: one board can carry several adverts
  // for one employer, and refreshCompanyIndustries re-reads that company's whole open set each time.
  const touched = new Set<string>();
  const found: any[] = [];
  const problems: string[] = [];

  for (const src of boards ?? []) {
    if (budget.exhausted) break;
    stats.boards++;
    try {
      const rule = ruleFor(src.url, src.link_rule);
      const index = await fetchPage(rule?.index ?? src.url, rule?.browser ? { force: 'browser' } : {});
      if (index.status !== 'live') { problems.push(`${src.url}: index ${index.note ?? 'not reachable'}`); continue; }

      const links = articleLinks(index, perBoard, rule?.pattern);
      stats.linksSeen += links.length;

      for (const url of links) {
        if (budget.exhausted) break;
        const { data: seen } = await db.from('job_posts').select('id').eq('source_url', url).maybeSingle();
        if (seen) {
          stats.alreadyHad++;
          await db.from('job_posts').update({ last_seen_at: new Date().toISOString() }).eq('id', seen.id);
          continue;
        }

        const page = await fetchPage(url);
        if (page.status !== 'live' || page.text.length < 300) continue;
        stats.read++;

        let x: z.output<typeof Posting>;
        try {
          const ai = await claude.messages.create({
            model: MODEL_CLASSIFY, max_tokens: 700, system: POSTING_SYSTEM,
            messages: [{ role: 'user', content: `URL: ${url}\n\n${page.text.slice(0, 9000)}` }],
          });
          budget.add(await logModelCall(db, ws.id, MODEL_CLASSIFY, `board advert ${new URL(url).hostname}`, ai.usage));
          const text = ai.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
          x = Posting.parse(JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}'));
        } catch (e: any) { problems.push(`${url}: ${String(e?.message ?? e).slice(0, 80)}`); continue; }

        if (!x.is_trade_vacancy) { stats.notTrade++; continue; }
        // A row without a real title is not a posting anyone can act on.
        const role = cleanTitle(x.role);
        if (!role) { stats.noTitle++; continue; }

        // The honesty check: a company name must actually be on the page. A model that answers
        // "Aker Solutions" for an advert reading "a leading Norwegian contractor" has guessed.
        if (x.employer && !appearsIn(page.text, x.employer)) { x.employer = undefined; }
        if (x.poster && !appearsIn(page.text, x.poster)) { x.poster = undefined; }

        const country = countryFromJobLocation(x.location) ?? (x.country && x.country.length === 2 ? x.country.toUpperCase() : undefined);
        if (country && !isEuropean(country)) { stats.outsideEurope++; continue; }

        // Who placed it. The stored agency list decides before the model's own opinion does.
        const posterDetected = x.poster ? detectEmployerType(x.poster, agencyNames).employerType : 'unknown';
        const posterIsAgency = posterDetected === 'staffing_agency' || x.poster_is_agency === true;
        if (posterIsAgency) stats.agencyPosted++;

        // The employer, only where named. An unnamed employer stays unnamed: attaching the
        // advert to the agency that placed it would file a competitor's vacancy as a lead.
        let companyId: string | null = null;
        if (x.employer) {
          stats.employerNamed++;
          const hit = await findOrCreateCompany(db, {
            workspaceId: ws.id, name: x.employer, country: country ?? null,
            agencyNames, source: 'job board advert', sourceUrl: url,
          });
          companyId = hit?.id ?? null;
        }

        // Secondary to the company's own board: if we already read this employer's careers page
        // for the same role, the advert adds nothing but noise.
        let secondary = true;
        let duplicateOf: string | null = null;
        if (companyId) {
          const { data: direct } = await db.from('job_posts')
            .select('id, role').eq('company_id', companyId).eq('status', 'open')
            .in('via', ['ats', 'http', 'browser']).limit(50);
          const same = (direct ?? []).find((d: any) => sameRole(d.role, role));
          if (same) { duplicateOf = same.id; stats.secondary++; }
        }

        const trades = inferTrades(x.trades, role, x.location).trades;
        const { error: up } = await db.from('job_posts').upsert({
          // Same omission as the careers/ATS crawl, and fixed for the same reason: a posting with no
          // workspace and no lead is reachable only through its company, which is not a guarantee anybody
          // wrote down. This path has produced no rows yet (no via='board' exists), so it is unproven rather
          // than innocent — it had the identical gap and ws.id in scope all along.
          workspace_id: ws.id,
          company_id: companyId, source_id: src.id, source_url: url,
          title: role, role, trades,
          location: x.location ?? null, country: country ?? null,
          certs_required: x.certs_required, rotation: x.rotation ?? null,
          contract_type: x.contract_type ?? null, headcount: x.headcount ?? null,
          // The advert's own JobPosting date first, then a date the reading copied off the page.
          // No date at all writes nothing, so the next crawl cannot blank one already stored.
          ...(page.posted ? { posted_at: page.posted.date } : isoDate(x.posted_at) ? { posted_at: isoDate(x.posted_at) } : {}),
          description: page.text.slice(0, 4000),
          via: 'board', is_trade: true, classified_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(), status: 'open',
          poster_name: x.poster ?? null,
          poster_type: posterIsAgency ? 'staffing_agency' : companyId ? 'end_client' : 'unknown',
          poster_confidence: x.poster ? 'stated' : 'unknown',
          is_secondary: secondary, duplicate_of: duplicateOf,
        }, { onConflict: 'source_url' });

        if (up) { problems.push(`${url}: ${up.code ?? ''} ${up.message}`.slice(0, 140)); continue; }
        stats.kept++;
        // Only when the advert is tied to a company: an unnamed employer has nothing to classify, and
        // poster_type 'unknown' rows are reachable through their workspace rather than a company.
        if (companyId) touched.add(companyId);
        found.push({ role, employer: x.employer ?? '(not named)', poster: x.poster ?? '(not named)', agency: posterIsAgency, where: x.location ?? country, duplicate: !!duplicateOf });
      }

    } catch (e: any) {
      problems.push(`${src.url}: ${String(e?.message ?? e).slice(0, 100)}`);
    } finally {
      // STAMPED WHATEVER HAPPENED, and `finally` because `continue` above must not skip it.
      //
      // The stamp used to sit at the end of the try, so a board whose index could not be fetched was
      // never marked read — and the batch picks the least recently crawled first, nullsFirst. On
      // 2026-09-22 that made the unit a permanent no-op within hours of going live:
      // oiljobfinder.com's index failed to open through the browser, the `continue` skipped the
      // stamp, it stayed first in the queue, and it was picked again on the very next tick. SIXTY
      // batches in one day, every one of them the same dead board, read=0 kept=0, while the eight
      // boards behind it were never touched and no posting ever arrived via='board'.
      //
      // A board that cannot be fetched should cost one attempt a day, not every attempt for ever.
      // The problem is still reported, so a board failing every day is visible in the tick's own
      // notes rather than silently skipped — this changes when it is retried, not whether the
      // failure is recorded.
      const { error: stampError } = await db.from('sources').update({ last_crawled_at: new Date().toISOString() }).eq('id', src.id);
      if (stampError) problems.push(`${src.url}: could not be marked as read (${stampError.message}) — it will be picked again next tick`);
    }
  }

  // The company of every advert kept, classified from its open adverts and the quoted words on its own
  // page — the same pure, free, no-model-call function the careers crawl uses. Reported and never fatal,
  // exactly as at job-posts-batch.ts:373: a classification that fails must not discard adverts already
  // written, and a silent failure here would put the visibility hole straight back.
  for (const id of touched) {
    const problem = await refreshCompanyIndustries(db, id);
    if (problem) problems.push(problem.slice(0, 200));
    else stats.classified++;
  }

  console.log(`[job-boards] boards=${stats.boards} read=${stats.read} kept=${stats.kept} classified=${stats.classified} agency=${stats.agencyPosted} spent=EUR${budget.totalToday.toFixed(2)}`);
  return NextResponse.json({
    ok: true, stats, chained,
    spentToday: Number(budget.totalToday.toFixed(4)), cap,
    found: found.slice(0, 30), problems: problems.slice(0, 10),
  });
}

const canon = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(a\/s|aps|as|ab|oy|gmbh|bv|nv|ltd|limited|llc|inc|plc|sa|group)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

/** "Welder (6G)" and "Welder - Esbjerg" are the same role advertised twice. */
const sameRole = (a?: string | null, b?: string | null) =>
  !!a && !!b && canon(String(a).replace(/\s*[-–—|(].*$/, '')) === canon(String(b).replace(/\s*[-–—|(].*$/, ''));

function isoDate(v?: string | null): string | null {
  if (!v) return null;
  const iso = String(v).match(/\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
