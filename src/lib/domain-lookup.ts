import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { claude, MODEL_CLASSIFY } from '@/lib/ai/claude';
import { logCost, logModelCall, type Budget } from '@/lib/cost';

/**
 * A company's own website, by one web search — the one implementation, used by /api/jobs/resolve-domains and the
 * sample script. Moved out of the route unchanged (Haiku, one search, two hops: Sonnet 5 with the filtering search
 * tool took 214 s and cost €0.28 for one company), with one addition: an address.
 *
 * A tender winner's name repeats across Europe, and the route passed only name, country and sector — for TED winners
 * the company row has no country at all. The award notice prints the winner's own postal address
 * (src/lib/tender/winner-address.ts); given, it goes into the query, and the model must reject a same-named company
 * somewhere else. A domain is still stored only when a page the model read names the company, quoted in confirmed_by.
 */
export const SEARCH_EUR = Number(process.env.WEB_SEARCH_EUR_PER_CALL ?? 0.0092); // ~$10/1000 at 0.92

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
- THE COUNTRY MUST MATCH. Company names repeat across countries: "AXYS" in Belgium is not AXYS Technologies in British Columbia. If the site you find is a different company in a different country, that is a miss — answer null. Only accept a site whose own pages place the company in the country given, or that is plainly the same group operating there.
- WHEN AN ADDRESS IS GIVEN, IT MUST MATCH TOO. It is the company's registered address from a public contract award notice. Use the town or postcode in your search. A company with the same name in another town is a different company — answer null — unless its own pages show it is the same company (the same address, or that office listed as its own).
- If the company is not clearly identifiable, or you only find it mentioned on someone else's page, answer {"domain": null, "confirmed_by": null, "source_url": null}. A wrong website is far worse than none.
- domain is the bare hostname without scheme or "www.".`;

export type LookupInput = {
  name: string; country?: string | null; sector?: string | null;
  address?: { street?: string | null; postalCode?: string | null; city?: string | null; country?: string | null } | null;
};

/** The user message: exactly name, country and sector as before, plus the notice's address when there is one. */
export function lookupPrompt(c: LookupInput): string {
  const lines = [`Company: ${c.name}`];
  const a = c.address;
  if (a && (a.city || a.postalCode)) {
    lines.push(`Registered address (from the contract award notice): ${[a.street, [a.postalCode, a.city].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ')}`);
  }
  if (c.country) lines.push(`Country: ${c.country}`);
  if (c.sector) lines.push(`Sector: ${c.sector}`);
  return lines.join('\n');
}

export type LookupResult = { domain: string | null; confirmedBy: string | null; sourceUrl: string | null; eur: number; searches: number };

/** One lookup, logged to cost_log and added to the budget as it spends. Throws on an unreadable answer. */
export async function lookupDomain(c: LookupInput, ctx: { db: SupabaseClient; workspaceId: string; budget?: Budget; label?: string }): Promise<LookupResult> {
  let msgs: any[] = [{ role: 'user', content: lookupPrompt(c) }];
  let text = '';
  let searches = 0;
  let eur = 0;
  for (let hop = 0; hop < 2; hop++) {
    const r: any = await claude.messages.create({
      model: MODEL_CLASSIFY, max_tokens: 400, system: SYSTEM,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] as any,
      messages: msgs,
    } as any);
    const tokensEur = await logModelCall(ctx.db, ctx.workspaceId, MODEL_CLASSIFY, `resolve ${ctx.label ?? c.name}`, r.usage);
    eur += tokensEur;
    ctx.budget?.add(tokensEur);
    searches += (r.content ?? []).filter((b: any) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result').length;
    text = (r.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    if (r.stop_reason !== 'pause_turn') break;
    msgs = [...msgs, { role: 'assistant', content: r.content }];
  }
  if (searches > 0) {
    await logCost(ctx.db, ctx.workspaceId, 'search', `web search · ${ctx.label ?? c.name}`, 1, SEARCH_EUR);
    eur += SEARCH_EUR;
    ctx.budget?.add(SEARCH_EUR);
  }
  const m = text.match(/\{[\s\S]*\}/);
  const ans = Answer.parse(JSON.parse(m ? m[0] : '{}'));
  const domain = (ans.domain ?? '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase() || null;
  return { domain: domain && ans.confirmed_by ? domain : null, confirmedBy: ans.confirmed_by, sourceUrl: ans.source_url, eur, searches };
}
