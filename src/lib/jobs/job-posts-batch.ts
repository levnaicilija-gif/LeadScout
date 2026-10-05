import { NextResponse } from 'next/server';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import { supabaseAdmin } from '@/lib/supabase/server';
import { crawlWorkspace } from '@/lib/crawl-workspace';
import { httpGet, httpPost } from '@/lib/http';
import { fetchPage } from '@/lib/fetch-page';
import { atsListUrl, parseAtsJobs, fetchWorkday, detectAts, type AtsJob, type AtsType } from '@/lib/ats';
import { claude, MODEL_CLASSIFY, MODEL_EXTRACT } from '@/lib/ai/claude';
import { logModelCall, Budget, DAILY_BUDGET_EUR } from '@/lib/cost';
import { inferTrades } from '@/lib/trades';
// The vocabulary itself, for the title prompt below. A pure data module — no model, no database.
import { TRADE_NAMES } from '@/lib/trade-vocabulary';
import { countryFromText, countryFromJobLocation, isEuropean } from '@/lib/geo';
import { cleanTitle, titleFromPage, stripFurniture, needsPageTitle } from '@/lib/job-title';
import { z } from 'zod';

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

import { postedFields } from '@/lib/posting-date';
import { refreshCompanyIndustries } from '@/lib/industry-store';
import { watchedBoards } from '@/lib/watchlist';

const fingerprint = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

/**
 * A date, or nothing. Workday writes "Posted Today" and "Posted 30+ Days Ago" where the other
 * vendors write a timestamp, and slicing that to ten characters gave Postgres "Posted Tod" —
 * which it rightly refused, losing the posting.
 */
function postedDate(v?: string | null): string | null {
  if (!v) return null;
  const s = String(v).trim();
  const iso = s.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  if (/^posted\s+today$/i.test(s)) return new Date().toISOString().slice(0, 10);
  if (/^posted\s+yesterday$/i.test(s)) return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/**
 * The title pass does three jobs at once, because the model is reading the title anyway and a
 * second call would cost the same again: is this a trade we place, which of our trades is it,
 * and does the title name a certificate.
 *
 * Doing it here is what makes a Norwegian or Dutch board usable. "Industrirørlegger",
 * "Servicemonteur" and "Stillasbygger" are pipefitter, mechanical fitter and scaffolder, and no
 * amount of English keyword matching was ever going to find them.
 */
const TitleVerdicts = z.object({
  keep: z.array(z.object({
    i: z.number(),
    trades: z.array(z.string()).nullish().transform((v) => v ?? []),
    certs: z.array(z.string()).nullish().transform((v) => v ?? []),
  })).nullish().transform((v) => v ?? []),
});

/**
 * THE TAXONOMY IS GENERATED FROM trade-vocabulary.ts, NEVER TYPED HERE (item 32, 2026-10-02).
 *
 * This prompt used to name "exactly these ten words" and list them by hand, which is how the crawl came to
 * speak a vocabulary the rest of the app had outgrown: the vocabulary grew to 39 trades on 2026-09-27 and the
 * MODEL was still told that anything outside the original ten "is discarded downstream". Only titles in
 * `keep` are ever inserted, so **97% of 7,722 titles read were discarded** — 484 seen per board against 19
 * kept, and 31 of 39 boards keeping nothing at all — and the 29 new trades could not reach Hiring now by any
 * route. The matcher was never the blocker; the prompt was.
 *
 * Generated, so the two cannot drift apart again. A hand-typed list has already drifted once, silently, and
 * the symptom was a 97% discard rate that looked like boards simply having no trade vacancies on them.
 * `trades-check` asserts this string actually contains the whole vocabulary rather than trusting the join.
 */
export const TITLE_TAXONOMY = TRADE_NAMES.join(', ');

/**
 * The ceiling on the title verdict. One object per KEPT title, so it scales with the taxonomy's willingness
 * to keep — see the long note at the call site for why 500 was already too low before item 32 widened it.
 * Exported so `trades-check` can assert it is large enough for the biggest board this crawl has met.
 */
export const TITLE_MAX_TOKENS = 2000;

/** What `writePosting` did, so a caller can count the three outcomes separately instead of guessing. */
export type PostingWrite =
  | { outcome: 'written'; error: null }
  /** The URL is already on file under a DIFFERENT company: the row was refreshed and ownership left alone. */
  | { outcome: 'refreshed_elsewhere'; error: null; ownerId: string }
  | { outcome: 'failed'; error: string };

/**
 * Write one posting, and NEVER let a duplicate company row steal a posting that is already on file.
 *
 * ITEM 39, 2026-10-05. `job_posts` carries TWO unique indexes: `job_posts_company_source_uidx` on
 * (company_id, source_url) from 0006, and `job_posts_source_url_uidx` on **source_url ALONE** from 0014. The
 * upsert targets the first, so a URL already on file under ANOTHER company violates the second and the write
 * is refused with `23505` — the posting is DROPPED, logged in `writeErrors`, and the run carries on. Seven
 * were lost that way in item 32's re-read.
 *
 * THE CAUSE IS DUPLICATE COMPANY ROWS, NOT STALE POSTINGS, and that is why this is not a one-line change to
 * `onConflict: 'source_url'`. All seven were pairs of rows for ONE firm: `VESTAS` and `Vestas Manufacturing`
 * share the identical `careers_url`; `Nadara` and `renantis` are the same company either side of its rebrand;
 * `FSE Fläminger Stahl- & Energieeelementebau GmbH` and `Fläminger Stahl- uns Energieelementebau GmbH` are
 * two misspellings. Conflicting on `source_url` alone would overwrite `company_id`, so each crawl would MOVE
 * the posting to whichever duplicate ran last — and since both rows are live and both are crawled, the owner
 * would FLAP every cycle, moving which Hiring now row shows the advert and which company accumulates its
 * signals. That trades a visible, logged refusal for a silent oscillation, which is worse.
 *
 * So the rule is: REFRESH, NEVER REASSIGN. A posting already on file elsewhere has its volatile fields
 * brought up to date — it is seen, it is open, its reading is the newest one — while `company_id` is left
 * exactly as it was, and the caller is told which company holds it so the duplicate pair can be named in the
 * run's report rather than discovered again next month. Merging the company rows is identity work
 * (`findOrCreateCompany`) and deliberately not done here, where a wrong merge is unrecoverable.
 */
export async function writePosting(db: any, row: Record<string, any>): Promise<PostingWrite> {
  // Read the error. A failed read here would look exactly like "no such URL" and would send the write down
  // the upsert path, straight back into the 23505 this function exists to stop.
  const { data: existing, error: readErr } = await db.from('job_posts')
    .select('id, company_id').eq('source_url', row.source_url).maybeSingle();
  if (readErr) return { outcome: 'failed', error: `the existing posting could not be looked up: ${readErr.code ?? ''} ${readErr.message}` };

  if (existing && existing.company_id && existing.company_id !== row.company_id) {
    // company_id is withheld deliberately — see the note above. Everything else is the fresh reading.
    const { company_id: _ignored, ...refresh } = row;
    const { error } = await db.from('job_posts').update(refresh).eq('id', existing.id);
    return error
      ? { outcome: 'failed', error: `${error.code ?? ''} ${error.message}` }
      : { outcome: 'refreshed_elsewhere', error: null, ownerId: String(existing.company_id) };
  }

  const { error } = await db.from('job_posts').upsert(row, { onConflict: 'company_id,source_url' });
  return error ? { outcome: 'failed', error: `${error.code ?? ''} ${error.message}` } : { outcome: 'written', error: null };
}

/** Exported so trades-check can assert BOTH halves of the operator rule survive — see item 47. */
export const TITLE_SYSTEM = `You are reading job titles for RFBT, which supplies skilled trades to industry.

RFBT's taxonomy is exactly these ${TRADE_NAMES.length} terms. "trades" may contain nothing else — anything outside this list is discarded downstream, so a more precise word is a lost one:
${TITLE_TAXONOMY}

Use the most precise term that fits. A rigger is a rigger, not a fitter; a crane operator is a crane operator. Only fall back to a broader term when no specific one applies.

Keep a title when it is one of those trades, or a foreman, supervisor or QA/QC inspector directly over them. The titles are in many languages: read them in whatever language they are written, and map to the list above.

Worked examples, so the mapping is not guessed at:
- "Industrirørlegger" (NO) → pipefitter
- "Servicemonteur", "Monteur Technische Dienst" (NL) → fitter
- "Stillasbygger", "Lærling i stillasbyggerfaget" (NO) → scaffolder
- "Serviceelektriker", "operatør innen elektrofag" (NO) → electrician
- "Windturbine monteur" (NL) → wind technician
- "Sveiser" (NO) / "Lasser" (NL) → welder
- "Isolatør" (NO) / "Isoleerder" (NL) → fitter
- "Overflatebehandler" (NO) → blaster, painter
- "Fagingeniør Mekanisk" (NO) → fitter
- "Werkplaatsmedewerker" (NL, workshop hand) → fitter
- "Rigger" (NO) → rigger, and "Kranfører" (NO) → crane operator. BOTH USED TO MAP TO fitter here, because neither trade existed in the old ten-word list; they are their own trades now, and mapping them to fitter would throw away exactly the precision this list was widened to capture.
- "EKH Keurmeester" (NL, lifting-gear inspector) → ndt

A BARE "OPERATOR" IS NOT A TRADE ON THIS LIST. The taxonomy holds several operator-shaped trades and each means one specific job: "dp operator" is DYNAMIC POSITIONING, holding a vessel on station, and "roustabout" is drilling crew on a rig. A control room, plant, machine, process or vehicle operator is none of them. Where a title says only "Operator" with no trade in it, return nothing for that title rather than reaching for the nearest operator word.

Worked examples of titles to REFUSE, so the line is not guessed at:
- "Control Room Operator" → nothing. A control room is not dynamic positioning.
- "Operator Tysvær, Norway" → nothing. A place name does not make it a trade.
- "Trencher Operator Trainee on board" → nothing. A trencher on a dredger is not drilling crew.
- "Machine Operator", "Process Operator", "Plant Operator" → nothing.
BUT A TITLE THAT NAMES A TRADE **AND** SAYS "OPERATOR" IS STILL THAT TRADE — refuse the bare word, never the trade beside it. These are KEEPS, not refusals:
- "DP Operator", "Dynamic Positioning Operator" → dp operator, and "Crane Operator" / "Kranfører" → crane operator: each names the actual job.
- "Fagoperatør Mekanisk" (NO, skilled mechanical operator) → mechanic. "Mekanisk" is the trade; "operatør" does not cancel it.
- "Offshore Operations & Maintenance Technician" → mechanic. Offshore O&M on a wind farm or platform is mechanical maintenance work.
- "Operatører innen elektrofag" (NO) → electrician, and "Industrimekaniker" / "Underhållsmekaniker" → mechanic.
The test is simple: does the title name a trade as well as a role word? Then keep it. Is "operator" the ONLY thing it says about the work? Then return nothing.

NOT wanted: office, sales, marketing, finance, HR, legal, IT, software, data, design, procurement, consultancy, graduate schemes, internships, or engineering roles that are desk-based design rather than site trades. An apprenticeship in a trade IS wanted.

"certs" holds only a certificate the title itself names (e.g. "EKH Keurmeester" → EKH). Empty otherwise — never infer one from the trade.

Return {"keep":[{"i":0,"trades":["pipefitter"],"certs":[]}]}, empty when none qualify.`;

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
    // A bare job id is kept as a link — the posting page is asked for its title (needsPageTitle) — but never stored as one.
    const idOnly = /^[\d\s._-]{4,}$/.test(title);
    if (!idOnly && (title.length < 4 || title.length > 140)) return;
    // Navigation, not a posting.
    // Button text, not a title. cleanTitle knows the phrases in every language we crawl.
    if (!idOnly && !cleanTitle(title)) return;
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

async function boardFor(c: any): Promise<{ jobs: AtsJob[]; via: string; raw: string; found?: { type: AtsType; slug: string } } | null> {
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
  // A board the rendered page links to is read as the vendor publishes it, with its real titles and places — not
  // as bare links whose last path segment would stand in for a title (DOF: dof.workable.com/jobs/1924855).
  const linked = detectAts(rendered.links.join('\n'));
  const linkedList = linked ? atsListUrl(linked.type, linked.slug) : null;
  if (linked && linkedList) {
    const r = await httpGet(linkedList, { headers: { accept: 'application/json,application/xml,text/xml' } }, 20000);
    const jobs = r.ok ? parseAtsJobs(linked.type, linked.slug, r.body) : [];
    if (jobs.length) return { jobs, via: 'ats', raw: r.body, found: linked };
  }
  const asHtml = rendered.links
    .map((l) => `<a href="${l}">${decodeURIComponent(l.split('/').filter(Boolean).pop() ?? '').replace(/[-_]+/g, ' ')}</a>`)
    .join('');
  const jobs = jobLinksFrom(asHtml, c.careers_url);
  return jobs.length ? { jobs, via: 'browser', raw: rendered.links.join('\n') } : null;
}

export async function runJobPostsBatch(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const batch = Math.max(1, Number(p.get('batch') ?? 12));
  const cap = Number(p.get('cap') ?? DAILY_BUDGET_EUR);
  const only = p.get('only');

  // Named, never "the first workspace": with two workspaces an unordered limit(1) could file this job's work under either.
  const ws = await crawlWorkspace(db).then((id) => ({ id, error: '' }), (e: Error) => ({ id: '', error: e.message }));
  if (!ws.id) return NextResponse.json({ error: ws.error }, { status: 500 });
  const budget = await Budget.open(db, cap);
  if (budget.exhausted) {
    return NextResponse.json({ ok: true, stopped: 'daily budget already spent', spentToday: budget.totalToday.toFixed(2), cap });
  }

  // Companies with a board, least recently crawled first.
  let q = db.from('companies')
    .select('id, name, domain, country, careers_url, ats_type, ats_slug, careers_needs_browser, careers_fingerprint, employer_type')
    .eq('careers_status', 'found').neq('employer_type', 'staffing_agency')
    .order('last_jobs_crawl_at', { ascending: true, nullsFirst: true }).limit(batch);
  if (only) q = q.ilike('name', `%${only}%`);
  // Item 18 part 4: ?watch=1 reads only watched boards (a followed industry) that are due their second read today.
  if (p.get('watch') === '1') {
    const watched = await watchedBoards(db);
    q = q.in('id', watched?.dueIds.length ? watched.dueIds : ['00000000-0000-0000-0000-000000000000']);
  }
  const { data: companies, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const stats = { companies: 0, unchanged: 0, noBoard: 0, titlesSeen: 0, tradeTitles: 0, postsWritten: 0, detailed: 0, outsideEurope: 0, noTitle: 0, refreshedElsewhere: 0 };
  const found: any[] = [];
  const writeErrors: string[] = [];
  // Item 39: adverts refreshed under a DUPLICATE company row, named so the pair can be merged by hand.
  const duplicateOwners: string[] = [];

  for (const c of companies ?? []) {
    if (budget.exhausted) break;
    stats.companies++;
    try {
      const board = await boardFor(c);
      // A vendor board found on the rendered page is kept, so the next crawl reads its list directly.
      if (board?.found && !c.ats_type) {
        const { error: atsErr } = await db.from('companies').update({ ats_type: board.found.type, ats_slug: board.found.slug }).eq('id', c.id);
        if (atsErr) writeErrors.push(`${c.name}: the ${board.found.type} board could not be recorded: ${atsErr.message}`.slice(0, 200));
      }
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
      //
      // TITLE_MAX_TOKENS IS 2000, RAISED FROM 500 ON 2026-10-05, AND IT IS A PREREQUISITE OF ITEM 32'S
      // RE-READ RATHER THAN A TIDY-UP. The verdict is one object per KEPT title, so the reply grows with
      // what the prompt is willing to keep — and at 500 tokens it was ALREADY truncating on the ten-word
      // taxonomy: EnerMech and mennens both ended their last crawl on "Expected ',' or ']' after array
      // element in JSON at position 1201 / 1161", which is a reply cut off mid-array. Boards here run to 60
      // titles, so widening the taxonomy to 39 trades would have multiplied that — and the failure takes the
      // WHOLE board with it (0 kept, an `error:` status), which means the biggest and most productive boards
      // are exactly the ones that would have been lost, while the run still paid for every one of them.
      const ai = await claude.messages.create({
        model: MODEL_CLASSIFY, max_tokens: TITLE_MAX_TOKENS, system: TITLE_SYSTEM,
        messages: [{ role: 'user', content: board.jobs.map((j, i) => `${i}: ${j.title}${j.location ? ` — ${j.location}` : ''}`).join('\n') }],
      });
      budget.add(await logModelCall(db, ws.id, MODEL_CLASSIFY, `job titles ${c.name}`, ai.usage));
      // A TRUNCATED REPLY SAYS SO, instead of arriving as a parse error that reads like a broken board. The
      // two are different faults needing different fixes — one is a token ceiling, the other is a model
      // returning something that is not JSON — and the old wording could not tell them apart. This is the
      // same rule as "an empty Decision-maker cell says WHICH absence it is".
      if (ai.stop_reason === 'max_tokens') {
        throw new Error(`the title verdict was cut off at the ${TITLE_MAX_TOKENS}-token ceiling after ${board.jobs.length} titles — raise TITLE_MAX_TOKENS; the board was NOT judged`);
      }
      const text = ai.content.filter((x) => x.type === 'text').map((x: any) => x.text).join('');
      const keep = TitleVerdicts.parse(JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}')).keep
        .filter((k) => Number.isInteger(k.i) && k.i >= 0 && k.i < board.jobs.length);
      stats.tradeTitles += keep.length;

      const seenUrls: string[] = [];
      for (const k of keep) {
        const j = board.jobs[k.i];
        seenUrls.push(j.url);

        // The link text is usually the title and sometimes a button. Where it is a button, ask
        // the posting page what it calls itself; where neither says, drop the row rather than
        // storing "Bekijk deze vacature" as a trade.
        // Link text is a title with the page stuck to it: the role, the division, the town,
        // the hours, sometimes the salary, run together with no spaces. Where it is a button or
        // carries that furniture, ask the posting page what it calls itself.
        let title = needsPageTitle(j.title, c.name) ? null : cleanTitle(stripFurniture(j.title, c.name));
        if (!title) {
          const page = await httpGet(j.url, {}, 15000);
          title = page.ok ? titleFromPage(page.body) : null;
          if (!title) title = cleanTitle(stripFurniture(j.title, c.name));
        }
        if (!title) { stats.noTitle++; continue; }
        // The model read the title in its own language; inferTrades then maps whatever it said
        // onto the taxonomy and drops anything outside it.
        const trades = inferTrades(k.trades, title, j.location).trades;
        const country = countryFromJobLocation(j.location) ?? countryFromJobLocation(title) ?? c.country ?? undefined;

        // The geography gate. A Baker Hughes vacancy in the UAE or Brazil is a real posting and
        // no use to RFBT, who staff Europe; storing it would only crowd out the ones that are.
        // An unknown country is kept — not knowing is not the same as knowing it is elsewhere.
        if (country && !isEuropean(country)) { stats.outsideEurope++; continue; }

        const row: any = {
          // The workspace this posting belongs to. Omitting it wrote 31 rows with workspace_id AND lead_id
          // both null (2026-09-17, still being written days after 0016's backfill), which 0016's policy can
          // only reach through its third arm — the company — so they were readable by luck rather than by
          // design, and Hiring now lost 12 companies for every signed-in user while the service role saw
          // them all. crawlWorkspace() throws rather than returning null, so ws.id is always a real
          // workspace here; 0043 will make the column not null so a third writer cannot repeat this quietly.
          workspace_id: ws.id,
          company_id: c.id, source_url: j.url, title, role: title,
          location: j.location ?? null, country: country ?? null, trades, certs_required: k.certs,
          // A date the feed lists, else the one already stored (left alone), else the posting's own
          // page. No date writes nothing: a crawl used to blank posted_at on every re-read.
          ...(await postedFields(db, j.url, postedDate(j.postedAt), `the ${board.via} list`)),
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
              messages: [{ role: 'user', content: `${title}\n\n${body}` }],
            });
            budget.add(await logModelCall(db, ws.id, MODEL_EXTRACT, `job body ${title.slice(0, 40)}`, detail.usage));
            const dt = detail.content.filter((x) => x.type === 'text').map((x: any) => x.text).join('');
            const d = JobDetail.parse(JSON.parse(dt.match(/\{[\s\S]*\}/)?.[0] ?? '{}'));
            Object.assign(row, {
              role: d.role ?? row.role,
              trades: d.trades.length ? inferTrades(d.trades, title, d.location ?? j.location).trades : row.trades,
              location: d.location ?? row.location,
              country: (d.country && d.country.length === 2 ? d.country.toUpperCase() : countryFromText(d.country)) ?? row.country,
              certs_required: d.certs_required, rotation: d.rotation ?? null,
              contract_type: d.contract_type ?? null, headcount: d.headcount ?? null,
              description: body.slice(0, 4000),
            });
            stats.detailed++;
          } catch { /* the title-level row still stands */ }
        }

        const wrote = await writePosting(db, row);
        if (wrote.outcome === 'failed') {
          // A posting that Haiku kept and the database refused is a silent hole in Hiring now.
          writeErrors.push(`${c.name} · ${row.role}: ${wrote.error}`.slice(0, 200));
        } else if (wrote.outcome === 'refreshed_elsewhere') {
          // NOT an error and NOT a new posting: the advert is already on file under a duplicate company row,
          // so it was refreshed in place and ownership was left alone. Named rather than counted, because the
          // only real fix is merging the two company rows and that needs a person.
          stats.refreshedElsewhere++;
          const { data: owner } = await db.from('companies').select('name').eq('id', wrote.ownerId).maybeSingle();
          duplicateOwners.push(`${c.name} · ${row.role}: already on file under "${owner?.name ?? wrote.ownerId}" — refreshed there, ownership unchanged`.slice(0, 220));
        } else {
          stats.postsWritten++;
          found.push({ company: c.name, title: row.role, location: row.location, country: row.country, via: board.via });
        }
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
      // Item 18: the company's industries follow its open adverts. Reported with the batch, never fatal.
      const industryProblem = await refreshCompanyIndustries(db, c.id);
      if (industryProblem) writeErrors.push(industryProblem.slice(0, 200));
    } catch (e: any) {
      await db.from('companies').update({ last_jobs_crawl_at: new Date().toISOString(), jobs_crawl_status: `error: ${String(e?.message ?? e).slice(0, 80)}` }).eq('id', c.id);
    }
  }

  console.log(`[job-posts] companies=${stats.companies} titles=${stats.titlesSeen} trade=${stats.tradeTitles} written=${stats.postsWritten} spent=EUR${budget.totalToday.toFixed(2)}`);
  return NextResponse.json({
    ok: true, stats,
    spentToday: Number(budget.totalToday.toFixed(4)), cap, budgetLeft: Number(budget.remaining.toFixed(4)),
    found: found.slice(0, 40),
    writeErrors: writeErrors.slice(0, 10),
    // Item 39: adverts that are already on file under a DUPLICATE company row. Reported separately from
    // writeErrors on purpose — they are no longer failures, and they name the company pairs a person needs
    // to merge. An empty list is the healthy state; a growing one is an identity problem, not a crawl one.
    duplicateOwners: duplicateOwners.slice(0, 10),
  });
}
