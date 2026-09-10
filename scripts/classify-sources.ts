/**
 * Classify every source locally, with no 300 s ceiling to work around.
 *
 * Results are cached to .cache/source-tiers.json before anything is written, so a run costs
 * money once: if the columns from migration 0011 are not there yet, re-running with --apply
 * writes the cached verdicts without asking Haiku again.
 *
 *   npx tsx --env-file=.env.local scripts/classify-sources.ts           classify and write
 *   npx tsx --env-file=.env.local scripts/classify-sources.ts --apply   write the cache only
 */
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import { httpGet } from '../src/lib/http';
import { claude, MODEL_CLASSIFY } from '../src/lib/ai/claude';
import { modelCostEur } from '../src/lib/cost';

const CACHE = path.join(process.cwd(), '.cache', 'source-tiers.json');
const applyOnly = process.argv.includes('--apply');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

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
let spend = 0;

async function classify(src: any) {
  const res = await httpGet(src.url, {}, 15000);
  let sample = '(the front page could not be fetched)';
  let reachable = false;
  if (res.ok && res.body) {
    reachable = true;
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
  spend += modelCostEur(MODEL_CLASSIFY, ai.usage?.input_tokens ?? 0, ai.usage?.output_tokens ?? 0);
  const text = ai.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  const v = Verdict.parse(JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}'));
  return { id: src.id, url: src.url, reachable, tier: tierOf(v.relevance), relevance: v.relevance, topics: v.topics, reason: v.reason };
}

async function pool<T>(items: T[], size: number, fn: (t: T, i: number) => Promise<void>) {
  const queue = items.map((t, i) => [t, i] as const);
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    for (let e = queue.shift(); e; e = queue.shift()) await fn(e[0], e[1]);
  }));
}

(async () => {
  let verdicts: any[] = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : [];

  if (!applyOnly) {
    const all: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from('sources').select('id, name, url, type').order('id').range(from, from + 999);
      if (!data?.length) break;
      all.push(...data);
      if (data.length < 1000) break;
    }
    const done = new Set(verdicts.map((v) => v.id));
    const todo = all.filter((s) => !done.has(s.id));
    console.log(`${all.length} sources · ${verdicts.length} already classified · ${todo.length} to do\n`);

    const failed: any[] = [];
    await pool(todo, 8, async (src, i) => {
      try {
        verdicts.push(await classify(src));
      } catch (e: any) {
        failed.push({ id: src.id, url: src.url, error: String(e?.message ?? e).slice(0, 120) });
      }
      const n = verdicts.length + failed.length;
      if (n % 25 === 0) {
        fs.mkdirSync(path.dirname(CACHE), { recursive: true });
        fs.writeFileSync(CACHE, JSON.stringify(verdicts, null, 1));
        console.log(`  ${n}/${todo.length} · EUR ${spend.toFixed(2)}`);
      }
    });
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(verdicts, null, 1));
    console.log(`\nclassified ${verdicts.length}, ${failed.length} failed, EUR ${spend.toFixed(2)}`);
    failed.slice(0, 10).forEach((f) => console.log(`  failed ${f.url}: ${f.error}`));
  }

  // Write. If 0011 is not applied yet this fails loudly and the cache is still on disk.
  let written = 0;
  for (const v of verdicts) {
    const { error } = await db.from('sources').update({
      tier: v.tier, relevance: v.relevance, topics: v.topics, tier_reason: v.reason,
      classified_at: new Date().toISOString(), enabled: v.tier !== 'off',
    }).eq('id', v.id);
    if (error) { console.error(`\ncould not write ${v.url}: ${error.message}\n(cache kept at ${CACHE} — re-run with --apply once migration 0011 is in)`); process.exit(1); }
    written++;
  }

  const counts = verdicts.reduce((a: any, v) => ({ ...a, [v.tier]: (a[v.tier] ?? 0) + 1 }), {});
  console.log(`\nwritten ${written}`);
  console.log(counts);
  console.log(`unreachable front pages: ${verdicts.filter((v) => !v.reachable).length}`);
  console.log('\ntop priority sources:');
  verdicts.filter((v) => v.tier === 'priority').sort((a, b) => b.relevance - a.relevance).slice(0, 20)
    .forEach((v) => console.log(`  ${v.relevance}  ${v.url}`));
})();
