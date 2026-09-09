import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/server';
import { claude, MODEL_CLASSIFY } from '@/lib/ai/claude';
import { logCost, logModelCall, modelCostEur } from '@/lib/cost';
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
const COUNTRIES = ['DK', 'NL', 'NO', 'DE', 'GB', 'BE', 'SE', 'IE', 'FI'];

/**
 * Anthropic bills web search per search on top of tokens. This rate is an assumption to be
 * confirmed against the first invoice; it is logged separately from token cost so the two can
 * be told apart.
 */
const SEARCH_EUR = Number(process.env.WEB_SEARCH_EUR_PER_CALL ?? 0.0092); // ~$10/1000 at 0.92

const Answer = z.object({
  domain: z.string().nullish().transform((v) => v ?? null),
  confirmed_by: z.string().nullish().transform((v) => v ?? null),
  source_url: z.string().nullish().transform((v) => v ?? null),
});

const SYSTEM = `You find the official website of a named company, for a recruitment agency building a list of employers.

Search the web, then answer with JSON only:
{"domain": "example.com", "confirmed_by": "the page text that names the company", "source_url": "the page you read"}

Rules:
- Return the company's OWN website, not a directory, aggregator, LinkedIn, Bloomberg, Wikipedia, a news article or a jobs board.
- Only answer with a domain when a page you actually read names that company as itself — its title, header or footer. Quote that text in confirmed_by.
- If the company is not clearly identifiable, or you only find it mentioned on someone else's page, answer {"domain": null, "confirmed_by": null, "source_url": null}. A wrong website is far worse than none.
- domain is the bare hostname without scheme or "www.".`;

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const limit = Number(p.get('limit') ?? 40);
  const capEur = Number(p.get('cap') ?? 100);

  const { data: ws } = await db.from('workspaces').select('id').limit(1).maybeSingle();
  if (!ws) return NextResponse.json({ error: 'no workspace' }, { status: 400 });
  const workspace = ws.id as string;

  // Spend already committed to this step, so the cap holds across invocations.
  const { data: prior } = await db.from('cost_log').select('eur').eq('workspace_id', workspace).eq('kind', 'search');
  let spent = (prior ?? []).reduce((a, r: any) => a + Number(r.eur ?? 0), 0);
  if (spent >= capEur) return NextResponse.json({ ok: false, reason: 'search cap already reached', spentEur: Number(spent.toFixed(2)), capEur });

  // Companies where somebody who hires trades actually works.
  const ops = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('people').select('company_name').eq('workspace_id', workspace).eq('ops_relevant', true).range(from, from + 999);
    if (!data || !data.length) break;
    data.forEach((x) => ops.add((x.company_name ?? '').trim().toLowerCase()));
    if (data.length < 1000) break;
  }

  const { data: pool } = await db.from('companies')
    .select('id, name, country, sector')
    .eq('workspace_id', workspace).in('country', COUNTRIES).in('sector', RELEVANT)
    .is('domain', null).is('careers_checked_at', null)
    .limit(1500);

  const todo = (pool ?? []).filter((c) => ops.has(c.name.trim().toLowerCase())).slice(0, limit);
  const stats = { looked: 0, resolved: 0, notFound: 0, errors: 0 };
  const found: any[] = [];

  for (const c of todo) {
    if (spent >= capEur) break;
    stats.looked++;
    try {
      let msgs: any[] = [{ role: 'user', content: `Company: ${c.name}\nCountry: ${c.country}\nSector: ${c.sector}` }];
      let text = '';
      let searches = 0;
      // Two hops, one search, Haiku. Sonnet 5 with the filtering search tool took 214 s and
      // cost €0.28 for one company — ten hours and €50 for the whole set.
      for (let hop = 0; hop < 2; hop++) {
        const r: any = await claude.messages.create({
          model: MODEL_CLASSIFY, max_tokens: 400, system: SYSTEM,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] as any,
          messages: msgs,
        } as any);
        spent += await logModelCall(db, workspace, MODEL_CLASSIFY, `resolve ${c.name}`, r.usage);
        searches += (r.content ?? []).filter((b: any) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result').length;
        text = (r.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        if (r.stop_reason !== 'pause_turn') break;
        msgs = [...msgs, { role: 'assistant', content: r.content }];
      }
      if (searches > 0) {
        const eur = SEARCH_EUR * Math.min(searches, 1);
        await logCost(db, workspace, 'search', `web search · ${c.name}`, Math.min(searches, 1), eur);
        spent += eur;
      }

      const m = text.match(/\{[\s\S]*\}/);
      const ans = Answer.parse(JSON.parse(m ? m[0] : '{}'));
      const domain = (ans.domain ?? '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();

      if (domain && ans.confirmed_by) {
        await db.from('companies').update({
          domain, source: 'web search', source_url: ans.source_url ?? null,
          rfbt_history: null,
        }).eq('id', c.id);
        stats.resolved++;
        found.push({ name: c.name, country: c.country, domain, confirmed_by: String(ans.confirmed_by).slice(0, 90) });
      } else {
        // Mark it looked-at so a later run does not pay for it again.
        await db.from('companies').update({ careers_status: 'no_domain_found' }).eq('id', c.id);
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
    ok: true, stats, found, chained,
    spentOnSearchEur: Number(spent.toFixed(3)), capEur,
    remainingInScope: remaining,
  });
}
