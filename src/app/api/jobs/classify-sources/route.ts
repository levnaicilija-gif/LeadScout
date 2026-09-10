import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/server';
import { httpGet } from '@/lib/http';
import { claude, MODEL_CLASSIFY } from '@/lib/ai/claude';
import { logModelCall } from '@/lib/cost';
export const maxDuration = 300;

/**
 * Read each source once and decide how often it deserves to be crawled.
 *
 * A morning cannot hold 600 sources, and most of them do not carry the kind of news RFBT
 * staffs. Haiku reads the name, the URL and a sample of the front page and returns a relevance
 * score with the topics it actually found, which becomes a tier:
 *
 *   priority   crawled every morning        — offshore wind, yards, oil & gas, EPC, fabrication
 *   standard   crawled weekly               — adjacent or mixed coverage
 *   off        not crawled, reason kept     — policy, hydrogen, batteries, biofuels, think-tanks
 *
 * The reason is stored on the row, so switching a source back on later is an argument with a
 * written position rather than a guess.
 *
 *   POST /api/jobs/classify-sources?batch=40           chained until every source is done
 *   POST /api/jobs/classify-sources?recheck=1          re-read sources already classified
 */
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

const Verdict = z.object({
  relevance: z.number().min(0).max(100),
  topics: z.array(z.string()).max(8).nullish().transform((v) => v ?? []),
  reason: z.string().max(400),
});

const SYSTEM = `You are sorting news sources for RFBT, a European staffing company that supplies skilled trades to industry.

RFBT places: welders, pipefitters, platers, blasters, painters, coating inspectors, NDT technicians, scaffolders, riggers, rope access technicians, electricians, mechanical fitters, wind turbine technicians, marine crew, HVAC and insulation trades.

They earn work when a company WINS a contract, opens a yard, starts a fabrication or installation campaign, takes an offshore wind project into construction, or announces a shutdown, turnaround or refit. Those are the events worth reading a source for.

Score how likely THIS source is to carry that kind of news, 0-100:
- 80-100  offshore wind construction, shipyards and shiprepair, oil and gas projects, EPC and fabrication contract awards, marine contracting, subsea, industrial maintenance and turnarounds, port and terminal construction
- 40-79   energy or maritime trade press that mixes project news with policy or markets; regional industrial press; tender portals
- 0-39    policy and regulation, hydrogen, batteries and storage, biofuels and e-fuels, solar PV, research institutes, think-tanks, finance and investment, carbon markets, climate and NGO coverage, software, general news, consumer press

Hydrogen, batteries, biofuels, solar and policy sites score below 39 even when they mention construction: RFBT's trades are not the ones those projects hire.

Return JSON only: {"relevance":0-100,"topics":["what the source actually covers"],"reason":"one sentence, plain English, naming what you saw on the page"}
If the page could not be read, judge from the name and URL alone and say so in the reason.`;

const tierOf = (r: number) => (r >= 70 ? 'priority' : r >= 40 ? 'standard' : 'off');

async function classify(db: any, workspace: string, src: any) {
  const res = await httpGet(src.url, {}, 15000);
  let sample = '(the front page could not be fetched)';
  if (res.ok && res.body) {
    const $ = cheerio.load(res.body);
    $('script, style, noscript, svg').remove();
    const headlines = $('h1, h2, h3, a[href]').slice(0, 150).map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get()
      .filter((t) => t.length > 12).slice(0, 40).join(' | ');
    sample = [
      `TITLE: ${$('title').first().text().trim()}`,
      `DESCRIPTION: ${$('meta[name="description"]').attr('content') ?? ''}`,
      `HEADLINES: ${headlines.slice(0, 1800)}`,
    ].join('\n');
  } else {
    sample += `: ${res.error ?? `HTTP ${res.status}`}`;
  }

  const ai = await claude.messages.create({
    model: MODEL_CLASSIFY, max_tokens: 300, system: SYSTEM,
    messages: [{ role: 'user', content: `Source name: ${src.name ?? '(none)'}\nURL: ${src.url}\nType: ${src.type}\n\n${sample}` }],
  });
  await logModelCall(db, workspace, MODEL_CLASSIFY, `classify-source ${src.url}`, ai.usage);
  const text = ai.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  const v = Verdict.parse(JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}'));
  const tier = tierOf(v.relevance);
  return {
    tier, relevance: v.relevance, topics: v.topics, tier_reason: v.reason,
    classified_at: new Date().toISOString(), classify_error: null,
    // A source scored off is switched off; the reason above says why.
    enabled: tier !== 'off',
  };
}

/** Small pool — the fetches dominate, and 8 at a time keeps a batch inside the function budget. */
async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    for (let it = queue.shift(); it; it = queue.shift()) await fn(it);
  }));
}

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const batch = Math.max(1, Number(p.get('batch') ?? 40));
  const recheck = p.get('recheck') === '1';
  const chain = p.get('chain') !== '0';
  const batchesLeft = Number(p.get('batchesLeft') ?? 25);

  const { data: ws } = await db.from('workspaces').select('id').limit(1).maybeSingle();
  if (!ws) return NextResponse.json({ error: 'no workspace' }, { status: 400 });

  // The cursor is "not yet classified" rather than an offset, so a batch that fails is simply
  // picked up again by the next run instead of being skipped over.
  let q = db.from('sources').select('id, name, url, type').order('id').limit(batch);
  if (!recheck) q = q.is('classified_at', null);
  const { data: sources } = await q;

  const counts = { priority: 0, standard: 0, off: 0, failed: 0 };
  const examples: any[] = [];

  await pool(sources ?? [], 8, async (src) => {
    try {
      const patch = await classify(db, ws.id, src);
      await db.from('sources').update(patch).eq('id', src.id);
      counts[patch.tier as 'priority' | 'standard' | 'off']++;
      examples.push({ url: src.url, tier: patch.tier, relevance: patch.relevance, why: patch.tier_reason });
    } catch (e: any) {
      counts.failed++;
      // Never silently drop a source: record why it could not be judged and leave it enabled.
      await db.from('sources').update({ classify_error: String(e?.message ?? e).slice(0, 200), classified_at: new Date().toISOString() }).eq('id', src.id);
    }
  });

  const { count: remaining } = await db.from('sources').select('id', { count: 'exact', head: true }).is('classified_at', null);

  let chained = false;
  if (chain && (remaining ?? 0) > 0 && batchesLeft > 1 && !recheck) {
    const u = new URL(req.url);
    u.searchParams.set('batchesLeft', String(batchesLeft - 1));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    await fetch(u.toString(), { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET! }, signal: ac.signal }).catch(() => {});
    chained = true;
  }

  console.log(`[classify-sources] did=${(sources ?? []).length} priority=${counts.priority} standard=${counts.standard} off=${counts.off} failed=${counts.failed} remaining=${remaining}`);
  return NextResponse.json({ ok: true, did: (sources ?? []).length, counts, remaining, chained, examples: examples.slice(0, 15) });
}
