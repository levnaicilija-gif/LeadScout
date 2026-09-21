import * as cheerio from 'cheerio';
import { z } from 'zod';
import { httpGet } from '@/lib/http';
import { claude, MODEL_CLASSIFY } from '@/lib/ai/claude';
import { Budget, logModelCall } from '@/lib/cost';

/**
 * How often a source deserves to be crawled — one rule, reached by the job route and by a script.
 *
 * Moved out of api/jobs/classify-sources UNCHANGED on 2026-09-21, the same way the website lookup
 * moved out of resolve-domains into domain-lookup.ts. Nothing about the prompt or the thresholds is
 * different here; the only reason it moved is that a single mis-judged row could not be re-read
 * without re-running a batch, and re-typing a forty-line prompt into a one-off script is how two
 * copies of a rule start disagreeing.
 *
 *   priority   crawled every morning        — offshore wind, yards, oil & gas, EPC, fabrication
 *   standard   crawled weekly               — adjacent or mixed coverage
 *   off        not crawled, reason kept     — policy, hydrogen, batteries, biofuels, think-tanks
 *
 * The reason is stored on the row, so switching a source back on later is an argument with a written
 * position rather than a guess. That only holds while the reason is ABOUT the row it sits on:
 * offshore.no/jobs carried E24's verdict — its reason, its topics and its relevance of 15 — and was
 * switched off on a judgement of a Norwegian news site it has nothing to do with.
 *
 * KNOWN LIMIT, and deliberately not changed here (2026-09-21): the prompt below sorts NEWS sources
 * and scores "how likely this source is to carry that kind of news". A job board carries postings,
 * not news, so every job_board row is scored on a question it cannot pass — which is why 30 of 41
 * sit at relevance 0-39. Whether that rule should apply to this source type at all is its own
 * decision, and is being investigated separately rather than quietly fixed in passing.
 */
export const SYSTEM = `You are sorting news sources for RFBT, a European staffing company that supplies skilled trades to industry.

RFBT places: welders, pipefitters, platers, blasters, painters, coating inspectors, NDT technicians, scaffolders, riggers, rope access technicians, electricians, mechanical fitters, wind turbine technicians, marine crew, HVAC and insulation trades.

They earn work when a company WINS a contract, opens a yard, starts a fabrication or installation campaign, takes an offshore wind project into construction, or announces a shutdown, turnaround or refit. Those are the events worth reading a source for.

Score how likely THIS source is to carry that kind of news, 0-100:
- 80-100  offshore wind construction, shipyards and shiprepair, oil and gas projects, EPC and fabrication contract awards, marine contracting, subsea, industrial maintenance and turnarounds, port and terminal construction
- 40-79   energy or maritime trade press that mixes project news with policy or markets; regional industrial press; tender portals
- 0-39    policy and regulation, hydrogen, batteries and storage, biofuels and e-fuels, solar PV, research institutes, think-tanks, finance and investment, carbon markets, climate and NGO coverage, software, general news, consumer press

Hydrogen, batteries, biofuels, solar and policy sites score below 39 even when they mention construction: RFBT's trades are not the ones those projects hire.

Return JSON only: {"relevance":0-100,"topics":["what the source actually covers"],"reason":"one sentence, plain English, naming what you saw on the page"}
If the page could not be read, judge from the name and URL alone and say so in the reason.`;

export const Verdict = z.object({
  relevance: z.number().min(0).max(100),
  topics: z.array(z.string()).max(8).nullish().transform((v) => v ?? []),
  reason: z.string().max(400),
});

export const tierOf = (r: number) => (r >= 70 ? 'priority' : r >= 40 ? 'standard' : 'off');

export type SourceRow = { id: string; name?: string | null; url: string; type?: string | null };

/** Reads the front page, asks Haiku, and returns the patch the caller writes. Never writes itself. */
export async function classifySource(db: any, workspace: string, src: SourceRow, budget: Budget) {
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
  budget.add(await logModelCall(db, workspace, MODEL_CLASSIFY, `classify-source ${src.url}`, ai.usage));
  const text = ai.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  const v = Verdict.parse(JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}'));
  const tier = tierOf(v.relevance);
  return {
    patch: {
      tier, relevance: v.relevance, topics: v.topics, tier_reason: v.reason,
      classified_at: new Date().toISOString(), classify_error: null,
      // A source scored off is switched off; the reason above says why.
      enabled: tier !== 'off',
    },
    usage: { input: ai.usage.input_tokens, output: ai.usage.output_tokens },
    fetched: res.ok,
  };
}
