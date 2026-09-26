import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { crawlWorkspace } from '@/lib/crawl-workspace';
import { lookupDomain } from '@/lib/domain-lookup';
import { siteScope } from '@/lib/site-scope';
import { nonProspect } from '@/lib/prospect-scope';
import { hasDomainProvenance } from '@/lib/schema-features';
import { Budget, spentEur } from '@/lib/cost';
export const maxDuration = 300;

/**
 * Resolve a company's website by web search, for the companies worth paying to resolve.
 *
 * Bounded deliberately: a relevant sector, a priority country, and at least one ops-relevant
 * attendee on record — a company where somebody who hires trades actually works. That is 177
 * companies, not 1,892. Everything else resolves lazily, when a recruiter first needs it.
 *
 *   POST /api/jobs/resolve-domains?limit=60&cap=100
 *
 * A domain is stored ONLY when the fetched page itself names the company; the model is told to
 * answer null rather than guess, and the confirming text is stored beside the domain.
 */
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

const RELEVANT = ['offshore_wind', 'shipyard', 'oil_gas', 'epc', 'industrial', 'marine_contractor', 'om_service'];
// Spain added 2026-09-15: 353 Spanish companies from Industry Contacts had no domain because it was not on this list.
const COUNTRIES = ['DK', 'NL', 'NO', 'DE', 'GB', 'BE', 'SE', 'IE', 'FI', 'ES'];

// The lookup itself — prompt, model, search, cost logging — is src/lib/domain-lookup.ts, shared with the sample script.

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const limit = Number(p.get('limit') ?? 40);
  const capEur = Number(p.get('cap') ?? 100);

  // Named, never "the first workspace": with two workspaces an unordered limit(1) could file this job's work under either.
  const ws = await crawlWorkspace(db).then((id) => ({ id, error: '' }), (e: Error) => ({ id: '', error: e.message }));
  if (!ws.id) return NextResponse.json({ error: ws.error }, { status: 500 });
  const workspace = ws.id as string;

  // Spend already committed to this step, so the cap holds across invocations.
  // System-wide and paged: search is the shared crawl's spend, and an unpaged read stops at 1,000 rows.
  const prior = await spentEur(db, { kind: 'search' });
  let spent = prior;
  if (spent >= capEur) return NextResponse.json({ ok: false, reason: 'search cap already reached', spentEur: Number(spent.toFixed(2)), capEur });
  // The €2.00 daily cap as well as this job's own all-time search limit. Found 2026-09-15: it checked only the all-time
  // limit (€100 by default), so a run could spend the whole day's budget and more while every other job hard-stopped.
  const budget = await Budget.open(db);
  if (budget.exhausted) return NextResponse.json({ ok: false, reason: 'daily budget already spent', spentToday: Number(budget.totalToday.toFixed(4)) });

  // Companies where somebody who hires trades actually works.
  const ops = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('people').select('company_name').eq('workspace_id', workspace).eq('ops_relevant', true).range(from, from + 999);
    if (!data || !data.length) break;
    data.forEach((x) => ops.add((x.company_name ?? '').trim().toLowerCase()));
    if (data.length < 1000) break;
  }

  // 0033 counts lookups, and a miss is final only on the second (the lookup is not deterministic). Before 0033 the only
  // mark of a miss is careers_status; this queue filtered on careers_checked_at alone, which a miss never set, so every
  // run paid again for every company it had already missed.
  const provenance = await hasDomainProvenance(db);
  // A FRESH BUILDER PER PAGE. A PostgREST builder is mutable and returns itself, so calling .order() on one
  // object once per page appends a duplicate clause every time and .range() is re-set on the same request —
  // harmless over two pages, wrong in exactly the case this paging exists for. Built as a function instead.
  const page = (from: number) => {
    let q = db.from('companies')
      .select(`id, name, country, sector${provenance ? ', domain_lookups' : ''}`)
      // ?country=ES looks up one listed country only — the owner approved Spain's 38 first, not every country's remainder.
      .eq('workspace_id', workspace)
      .in('country', p.get('country') && COUNTRIES.includes(p.get('country')!.toUpperCase()) ? [p.get('country')!.toUpperCase()] : COUNTRIES)
      .in('sector', RELEVANT)
      .is('domain', null).is('careers_checked_at', null)
      .or('careers_status.is.null,careers_status.neq.no_domain_found');
    if (provenance) q = q.lt('domain_lookups', 2);
    return q.order('id').range(from, from + 999);
  };

  // PAGED, because .limit(1500) was a silent ceiling on the WRONG side of the ops filter. The eligible pool
  // measured 1,364 on 2026-09-26 — 136 rows of headroom, about 9% — and the ops filter runs in code AFTER
  // this read, so once the pool passes 1,500 the queue would see an arbitrary first slice by insertion order
  // and the ops filter would narrow that rather than the real population. Nothing would fail: it would just
  // quietly stop covering some companies. Adding PL and FR to COUNTRIES alone brings ~415 more candidates in,
  // so the next country widening is what would have hit it. `limit` still caps the paid lookups per run; this
  // only makes the candidate read complete.
  const pool: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from) as { data: any[] | null; error: any };
    // An unread error here would look exactly like "no more candidates" and silently end the queue early —
    // the class this codebase keeps meeting. Report it rather than treating a failed read as an empty one.
    if (error) return NextResponse.json({ error: `the candidate pool could not be read in full: ${error.message}` }, { status: 500 });
    pool.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  // Item 27's permanent scope rule, as BELT-AND-BRACES on top of the sector-and-ops predicate rather than
  // instead of it: an institution that slipped through a sector tag is skipped before it is paid for. The
  // port exception lives in prospect-scope.ts — "authority" would otherwise drop Tarragona Port Authority,
  // and a port contracts trades. Skips are counted and named, never silently dropped from the total.
  const inScope = (pool ?? []).filter((c) => ops.has(c.name.trim().toLowerCase()));
  const skipped: { name: string; category: string; term: string }[] = [];
  const todo = inScope.filter((c) => {
    const out = nonProspect(c.name);
    if (out) skipped.push({ name: c.name, category: out.category, term: out.term });
    return !out;
  }).slice(0, limit);
  const stats = { eligible: pool.length, withOpsContact: inScope.length, skippedNonProspect: skipped.length, looked: 0, resolved: 0, notFound: 0, errors: 0 };
  const found: any[] = [];

  // DRY RUN: build the queue, report exactly what it would do, and look nothing up. Added because item 27's
  // scope rules had to be VALIDATED before anything was paid for, and a lookup costs money whether or not
  // its answer is kept — the same reason resolve-wonwork-domains.ts stopped "looking up and discarding".
  // It answers the three questions that matter before a real run: is the eligible pool inside the old 1,500
  // ceiling, are the companies that already have a website absent from the queue, and what does the
  // non-prospect rule actually remove.
  if (p.get('dry') === '1') {
    return NextResponse.json({
      ok: true, dry: true, stats,
      ceiling: { eligible: pool.length, oldLimit: 1500, wouldHaveTruncated: pool.length > 1500 },
      wouldLookUp: todo.length,
      queue: todo.slice(0, 40).map((c: any) => ({ name: c.name, country: c.country, sector: c.sector, lookups: Number(c.domain_lookups ?? 0) })),
      skippedNonProspect: skipped.slice(0, 40),
      spentOnSearchEur: Number(spent.toFixed(3)), capEur,
    });
  }


  for (const c of todo) {
    // A company costs up to two model calls and a search: stop before one that the day cannot take.
    if (spent >= capEur || !budget.canAfford(0.1)) break;
    stats.looked++;
    try {
      const r = await lookupDomain({ name: c.name, country: c.country, sector: c.sector }, { db, workspaceId: workspace, budget });
      spent += r.eur;
      const domain = r.domain;
      const ans = { confirmed_by: r.confirmedBy, source_url: r.sourceUrl };

      const attempt = Number(c.domain_lookups ?? 0) + 1;
      const stamp = provenance ? { domain_lookups: attempt, domain_looked_up_at: new Date().toISOString() } : {};
      if (domain && ans.confirmed_by) {
        // With 0033 the search's result has its own columns and companies.source keeps where the company came from.
        const scope = siteScope({ companyName: c.name, domain, winnerCountry: c.country });
        await db.from('companies').update(provenance
          ? { domain, domain_source: 'web search', domain_source_url: ans.source_url ?? null, domain_address_check: 'no_address', domain_scope: scope.scope, domain_scope_reason: scope.reason, sector_note: null, ...stamp }
          : { domain, source: 'web search', source_url: ans.source_url ?? null, sector_note: null },
        ).eq('id', c.id);
        stats.resolved++;
        found.push({ name: c.name, country: c.country, domain, confirmed_by: String(ans.confirmed_by).slice(0, 90), scope: scope.scope });
      } else {
        // One miss is not final — the second is. Before 0033 there is no count, so the old mark stands.
        const final = !provenance || attempt >= 2;
        await db.from('companies').update({ ...stamp, ...(final ? { careers_status: 'no_domain_found' } : {}) }).eq('id', c.id);
        stats.notFound++;
      }
    } catch {
      stats.errors++;
    }
  }

  const remaining = (pool ?? []).filter((c) => ops.has(c.name.trim().toLowerCase())).length - stats.looked;

  // Hand the next batch to a fresh invocation. A web search takes long enough that eight
  // companies overran the 300 s budget, so batches stay small and chain instead. The request
  // is dispatched and abandoned on purpose — waiting would nest the budgets.
  const chain = p.get('chain') !== '0';
  const batchesLeft = Number(p.get('batchesLeft') ?? 80);
  let chained = false;
  if (remaining > 0 && chain && batchesLeft > 1 && spent < capEur && stats.looked > 0) {
    const u = new URL(req.url);
    u.searchParams.set('batchesLeft', String(batchesLeft - 1));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    await fetch(u.toString(), { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET! }, signal: ac.signal }).catch(() => {});
    chained = true;
  }

  console.log(`[resolve-domains] looked=${stats.looked} resolved=${stats.resolved} notFound=${stats.notFound} spent=€${spent.toFixed(2)} remaining=${remaining} chained=${chained}`);

  return NextResponse.json({
    ok: true, stats, found, chained, skippedNonProspect: skipped.slice(0, 20),
    spentOnSearchEur: Number(spent.toFixed(3)), capEur,
    remainingInScope: remaining,
  });
}
