import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { fetchPage, articleLinks } from '@/lib/fetch-page';
import { ruleFor } from '@/lib/source-rules';
import { claude, MODEL_CLASSIFY, MODEL_EXTRACT, appearsIn } from '@/lib/ai/claude';
import { logModelCall, Budget, DAILY_BUDGET_EUR } from '@/lib/cost';
import { inferTrades } from '@/lib/trades';
import { countryFromJobLocation, isEuropean } from '@/lib/geo';
import { detectEmployerType } from '@/lib/agency-detector';
import { hasJobBoardFields } from '@/lib/schema-features';
import { z } from 'zod';
export const maxDuration = 300;

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
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

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

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const batch = Math.max(1, Number(p.get('batch') ?? 4));
  const perBoard = Math.max(1, Number(p.get('perBoard') ?? 12));
  const cap = Number(p.get('cap') ?? DAILY_BUDGET_EUR);
  const only = p.get('only');
  const chain = p.get('chain') !== '0';
  const batchesLeft = Number(p.get('batchesLeft') ?? 12);

  if (!(await hasJobBoardFields(db))) {
    return NextResponse.json({ ok: true, skipped: 'migration 0014 has not been applied yet' });
  }

  const { data: ws } = await db.from('workspaces').select('id').limit(1).maybeSingle();
  if (!ws) return NextResponse.json({ error: 'no workspace' }, { status: 400 });
  const budget = await Budget.open(db, ws.id, cap);
  if (budget.exhausted) return NextResponse.json({ ok: true, stopped: 'daily budget already spent', spentToday: Number(budget.totalToday.toFixed(4)) });

  // Only boards worth the money: the tier Haiku scored, least recently crawled first.
  let q = db.from('sources').select('id, name, url, link_rule, workspace_id')
    .eq('type', 'job_board').eq('enabled', true)
    .order('last_crawled_at', { ascending: true, nullsFirst: true }).limit(batch);
  if (only) q = q.ilike('url', `%${only}%`);
  const { data: boards, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Dispatched before the work, so a batch killed by the 300 s wall keeps the chain alive.
  let chained = false;
  if (chain && !only && (boards ?? []).length === batch && batchesLeft > 1) {
    const u = new URL(req.url);
    u.searchParams.set('batchesLeft', String(batchesLeft - 1));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    await fetch(u.toString(), { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET! }, signal: ac.signal }).catch(() => {});
    chained = true;
  }

  // Companies we already know, so an advert can be matched to one rather than creating a new row.
  const { data: known } = await db.from('companies').select('id, name, employer_type, employer_type_override').eq('workspace_id', ws.id);
  const byName = new Map((known ?? []).map((c: any) => [canon(c.name), c]));
  const agencyNames = (known ?? []).filter((c: any) => (c.employer_type_override ?? c.employer_type) === 'staffing_agency').map((c: any) => c.name);

  const stats = { boards: 0, linksSeen: 0, alreadyHad: 0, read: 0, notTrade: 0, kept: 0, agencyPosted: 0, employerNamed: 0, outsideEurope: 0, secondary: 0 };
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

        if (!x.is_trade_vacancy || !x.role) { stats.notTrade++; continue; }

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
          const hit = byName.get(canon(x.employer));
          if (hit) companyId = hit.id;
          else {
            const det = detectEmployerType(x.employer, agencyNames);
            const { data: made } = await db.from('companies').insert({
              workspace_id: ws.id, name: x.employer, country: country ?? null,
              employer_type: det.employerType, source: 'job board advert', source_url: url,
            }).select('id, name, employer_type').single();
            if (made) { companyId = made.id; byName.set(canon(made.name), made); }
          }
        }

        // Secondary to the company's own board: if we already read this employer's careers page
        // for the same role, the advert adds nothing but noise.
        let secondary = true;
        let duplicateOf: string | null = null;
        if (companyId) {
          const { data: direct } = await db.from('job_posts')
            .select('id, role').eq('company_id', companyId).eq('status', 'open')
            .in('via', ['ats', 'http', 'browser']).limit(50);
          const same = (direct ?? []).find((d: any) => sameRole(d.role, x.role));
          if (same) { duplicateOf = same.id; stats.secondary++; }
        }

        const trades = inferTrades(x.trades, x.role, x.location).trades;
        const { error: up } = await db.from('job_posts').upsert({
          company_id: companyId, source_id: src.id, source_url: url,
          title: x.role, role: x.role, trades,
          location: x.location ?? null, country: country ?? null,
          certs_required: x.certs_required, rotation: x.rotation ?? null,
          contract_type: x.contract_type ?? null, headcount: x.headcount ?? null,
          posted_at: isoDate(x.posted_at), description: page.text.slice(0, 4000),
          via: 'board', is_trade: true, classified_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(), status: 'open',
          poster_name: x.poster ?? null,
          poster_type: posterIsAgency ? 'staffing_agency' : companyId ? 'end_client' : 'unknown',
          poster_confidence: x.poster ? 'stated' : 'unknown',
          is_secondary: secondary, duplicate_of: duplicateOf,
        }, { onConflict: 'source_url' });

        if (up) { problems.push(`${url}: ${up.code ?? ''} ${up.message}`.slice(0, 140)); continue; }
        stats.kept++;
        found.push({ role: x.role, employer: x.employer ?? '(not named)', poster: x.poster ?? '(not named)', agency: posterIsAgency, where: x.location ?? country, duplicate: !!duplicateOf });
      }

      await db.from('sources').update({ last_crawled_at: new Date().toISOString() }).eq('id', src.id);
    } catch (e: any) {
      problems.push(`${src.url}: ${String(e?.message ?? e).slice(0, 100)}`);
    }
  }

  console.log(`[job-boards] boards=${stats.boards} read=${stats.read} kept=${stats.kept} agency=${stats.agencyPosted} spent=EUR${budget.totalToday.toFixed(2)}`);
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
