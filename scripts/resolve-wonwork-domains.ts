/**
 * Find the websites of the companies behind open won-work leads that have none — paid, under the daily cap, resumable.
 *
 *   npx tsx --env-file=.env.local scripts/resolve-wonwork-domains.ts [--write] [--limit 200]
 *
 * Owner's decision 2026-09-15, after the sample (scripts/domain-lookup-sample.ts): search by name and country, as
 * /api/jobs/resolve-domains does — the notice's address in the query cost 18% more and missed vizoso.net — and use the
 * address afterwards, for free, to check the site found.
 *
 * For each company with no domain and not already looked up (careers_status 'no_domain_found'):
 *   1  the winner's own address from its award notice's XML (src/lib/tender/winner-address.ts), free — for its
 *      country, and for the check;
 *   2  one lookup (src/lib/domain-lookup.ts): a domain comes back only when a page the model read names the company;
 *   3  the check: the site's home page or a contact / imprint page prints the notice's postcode or town.
 * --write stores the domain with `source` 'web search · address printed on the site' or 'web search · address not
 * printed on the site' (or 'web search · no address in the notice') and the page the model read as `source_url`; a miss
 * is marked 'no_domain_found' so it is never paid for again. Without --write nothing is stored and nothing is marked.
 * Stops when the daily cap cannot take another lookup; run it again after 00:00 UTC to carry on where it stopped.
 */
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { Budget } from '../src/lib/cost';
import { crawlWorkspace } from '../src/lib/crawl-workspace';
import { lookupDomain } from '../src/lib/domain-lookup';
import { fetchNoticeXml, publicationNumber, winnerAddress, type WinnerAddress } from '../src/lib/tender/winner-address';
import { leadSource } from '../src/lib/lead-source';

const write = process.argv.includes('--write');
const limitAt = process.argv.indexOf('--limit');
const LIMIT = limitAt > 0 ? Number(process.argv[limitAt + 1]) : 200;
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ISO3_TO_2: Record<string, string> = { FRA: 'FR', DEU: 'DE', BEL: 'BE', NLD: 'NL', DNK: 'DK', NOR: 'NO', SWE: 'SE', FIN: 'FI', POL: 'PL', CZE: 'CZ', AUT: 'AT', ESP: 'ES', ITA: 'IT', PRT: 'PT', EST: 'EE', LVA: 'LV', LTU: 'LT', HRV: 'HR', SVN: 'SI', SVK: 'SK', ROU: 'RO', BGR: 'BG', HUN: 'HU', IRL: 'IE', GBR: 'GB', LUX: 'LU', GRC: 'GR', CHE: 'CH', CYP: 'CY', MLT: 'MT', ISL: 'IS' };

async function html(url: string) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 LeadScout' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }).catch(() => null);
  return res && res.ok ? await res.text().catch(() => '') : '';
}
const textOf = (h: string) => { const $ = cheerio.load(h); $('script, style, noscript').remove(); return $('body').text().replace(/\s+/g, ' '); };

/** The notice's postcode or town printed on the site's home page or one of its contact / imprint pages. */
async function addressPrinted(domain: string, a: WinnerAddress): Promise<'printed' | 'not printed' | 'site did not load'> {
  const wants = [a.postalCode, a.city?.split(/[-\s]/)[0]].filter((w): w is string => !!w && w.length >= 3).map((w) => w.toLowerCase());
  const home = await html(`https://${domain}`);
  if (!home) return 'site did not load';
  if (wants.some((w) => textOf(home).toLowerCase().includes(w))) return 'printed';
  const $ = cheerio.load(home);
  const links = [...new Set($('a[href]').map((_, x) => $(x).attr('href') ?? '').get().filter((h) => /contact|kontakt|impressum|imprint|mentions|legal|about|over-ons|om-oss|o-nas|chi-siamo|empresa/i.test(h)))].slice(0, 3);
  for (const l of links) {
    const url = l.startsWith('http') ? l : `https://${domain}${l.startsWith('/') ? '' : '/'}${l}`;
    const text = textOf(await html(url)).toLowerCase();
    if (wants.some((w) => text.includes(w))) return 'printed';
  }
  return 'not printed';
}

(async () => {
  const workspaceId = await crawlWorkspace(db);
  const { data: leads, error } = await db.from('leads').select('source_url, country, companies!inner(id, name, domain, careers_status)')
    .eq('workspace_id', workspaceId).eq('kind', 'won_work').eq('is_test', false).not('status', 'in', '("stale","not_for_us")')
    .is('companies.domain', null).limit(5000);
  if (error) throw new Error(error.message);
  const todo = new Map<string, { id: string; name: string; notice: string | null; leadCountry: string | null; lookedAt: boolean }>();
  for (const l of leads ?? []) {
    const c: any = l.companies;
    const notice = leadSource(l.source_url) === 'tender' ? publicationNumber(l.source_url) : null;
    const t = todo.get(c.id) ?? { id: c.id, name: c.name, notice, leadCountry: l.country ?? null, lookedAt: c.careers_status === 'no_domain_found' };
    t.notice ??= notice;
    todo.set(c.id, t);
  }
  const pending = [...todo.values()].filter((t) => !t.lookedAt).sort((a, b) => a.name.localeCompare(b.name)).slice(0, LIMIT);
  const budget = await Budget.open(db);
  const startSpend = budget.totalToday;
  console.log(`won-work companies with no website: ${todo.size} · already looked up and not found: ${[...todo.values()].filter((t) => t.lookedAt).length} · to look up now: ${pending.length} · spend today €${startSpend.toFixed(4)} of €${budget.capEur} · ${write ? 'writing' : 'dry run — nothing stored'}`);

  const tally = { looked: 0, found: 0, printed: 0, notPrinted: 0, didNotLoad: 0, noAddress: 0, notFound: 0, errors: 0, stoppedAtCap: 0 };
  for (const t of pending) {
    if (!budget.canAfford(0.05)) { tally.stoppedAtCap = pending.length - tally.looked; console.log(`\nstopped: the daily cap cannot take another lookup — ${tally.stoppedAtCap} left for after 00:00 UTC`); break; }
    const xml = t.notice ? await fetchNoticeXml(t.notice) : null;
    const a = xml ? winnerAddress(xml, t.name) : null;
    const country = (a?.country ? ISO3_TO_2[a.country] ?? a.country : null) ?? t.leadCountry;
    tally.looked++;
    try {
      const r = await lookupDomain({ name: t.name, country }, { db, workspaceId, budget, label: t.name });
      if (!r.domain) {
        tally.notFound++;
        console.log(`  ${t.name} (${country ?? '—'}): no website found · €${r.eur.toFixed(4)}`);
        if (write) await db.from('companies').update({ careers_status: 'no_domain_found' }).eq('id', t.id);
        continue;
      }
      tally.found++;
      const check = a && (a.city || a.postalCode) ? await addressPrinted(r.domain, a) : 'no address in the notice';
      if (check === 'printed') tally.printed++; else if (check === 'not printed') tally.notPrinted++; else if (check === 'site did not load') tally.didNotLoad++; else tally.noAddress++;
      const source = check === 'printed' ? 'web search · address printed on the site' : check === 'not printed' ? 'web search · address not printed on the site' : check === 'site did not load' ? 'web search · site did not load for the address check' : 'web search · no address in the notice';
      console.log(`  ${t.name} (${country ?? '—'}): ${r.domain} · €${r.eur.toFixed(4)} · ${check}${a?.city ? ` (${[a.postalCode, a.city].filter(Boolean).join(' ')})` : ''}`);
      if (write) {
        const { error: upErr } = await db.from('companies').update({ domain: r.domain, source, source_url: r.sourceUrl ?? null }).eq('id', t.id).is('domain', null);
        if (upErr) { tally.errors++; console.log(`    NOT STORED: ${upErr.message}`); }
      }
    } catch (e: any) {
      tally.errors++;
      console.log(`  ${t.name}: lookup failed — ${String(e?.message ?? e).slice(0, 100)}`);
    }
  }
  const spent = budget.totalToday - startSpend;
  console.log(`\nlooked up ${tally.looked} · website found ${tally.found} (address printed on the site ${tally.printed}, not printed ${tally.notPrinted}, site did not load ${tally.didNotLoad}, notice gave no address ${tally.noAddress}) · no website ${tally.notFound} · errors ${tally.errors}`);
  console.log(`this run spent €${spent.toFixed(4)} · €${tally.looked ? (spent / tally.looked).toFixed(4) : '—'} a company · spend today €${budget.totalToday.toFixed(4)} of €${budget.capEur}${tally.stoppedAtCap ? ` · ${tally.stoppedAtCap} still to look up` : ''}`);
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
