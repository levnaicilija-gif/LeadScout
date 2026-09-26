/**
 * Does the winner's address from the award notice make a website lookup cheaper or more accurate? Paid, under the
 * daily cap, report only — no domain is written.
 *
 *   npx tsx --env-file=.env.local scripts/domain-lookup-sample.ts [--n 8] [--max-eur 1.2]
 *
 * Sample: tender winners behind open won-work leads with no website on file, first N by name. For each, the winner's
 * address is read from the notice XML (src/lib/tender/winner-address.ts, free), then two lookups
 * (src/lib/domain-lookup.ts): A — name and the notice's country only, what the route sends; B — name and the full address.
 * Each answer is then checked for free: the site's home page and a contact / imprint page are fetched, and the answer
 * counts as verified only when one of them prints the notice's postcode or town.
 */
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { Budget } from '../src/lib/cost';
import { crawlWorkspace } from '../src/lib/crawl-workspace';
import { lookupDomain, type LookupResult } from '../src/lib/domain-lookup';
import { fetchNoticeXml, publicationNumber, winnerAddress, type WinnerAddress } from '../src/lib/tender/winner-address';
import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE } from '../src/lib/workspace-state';
import { probeAdmin } from '../src/lib/test-data';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('--n', '8'));
const MAX_EUR = Number(arg('--max-eur', '1.2'));
const db = probeAdmin();
const ISO3_TO_2: Record<string, string> = { FRA: 'FR', DEU: 'DE', BEL: 'BE', NLD: 'NL', DNK: 'DK', NOR: 'NO', SWE: 'SE', FIN: 'FI', POL: 'PL', CZE: 'CZ', AUT: 'AT', ESP: 'ES', ITA: 'IT', PRT: 'PT', EST: 'EE', LVA: 'LV', LTU: 'LT', HRV: 'HR', SVN: 'SI', SVK: 'SK', ROU: 'RO', BGR: 'BG', HUN: 'HU', IRL: 'IE', GBR: 'GB', LUX: 'LU', GRC: 'GR', CHE: 'CH' };

async function pageText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 LeadScout' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!res || !res.ok) return '';
  const html = await res.text().catch(() => '');
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  return `${$('body').text()} ${$('a[href]').map((_, a) => $(a).attr('href')).get().join(' ')}`.replace(/\s+/g, ' ');
}

/** Does the site print the notice's postcode or town, on its home page or a contact / imprint page it links? */
async function verify(domain: string, a: WinnerAddress): Promise<string> {
  const home = await pageText(`https://${domain}`);
  if (!home) return 'site did not load';
  const wants = [a.postalCode, a.city?.split(/[-\s]/)[0]].filter((w): w is string => !!w && w.length >= 3);
  if (wants.some((w) => home.toLowerCase().includes(w.toLowerCase()))) return `home page prints ${wants.find((w) => home.toLowerCase().includes(w.toLowerCase()))}`;
  const $ = cheerio.load(await (await fetch(`https://${domain}`, { signal: AbortSignal.timeout(15000) }).catch(() => null))?.text().catch(() => '') ?? '');
  const links = [...new Set($('a[href]').map((_, x) => $(x).attr('href') ?? '').get().filter((h) => /contact|kontakt|impressum|imprint|mentions|legal|about|over-ons|om-oss|o-nas/i.test(h)))].slice(0, 3);
  for (const l of links) {
    const url = l.startsWith('http') ? l : `https://${domain}${l.startsWith('/') ? '' : '/'}${l}`;
    const t = await pageText(url);
    const hit = wants.find((w) => t.toLowerCase().includes(w.toLowerCase()));
    if (hit) return `${new URL(url).pathname} prints ${hit}`;
  }
  return `neither ${wants.join(' nor ')} printed on the home page or ${links.length} contact page(s)`;
}

(async () => {
  const workspaceId = await crawlWorkspace(db);
  const { data: leads, error } = await db.from('leads').select(`source_url, companies!inner(id, name, domain), ${LEAD_STATE_EMBED}`)
    .eq('workspace_id', workspaceId).eq('kind', 'won_work').eq('is_test', false).not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES)
    .ilike('source_url', 'https://ted.europa.eu/%').is('companies.domain', null).limit(5000);
  if (error) throw new Error(error.message);
  const byCompany = new Map<string, { name: string; notice: string }>();
  for (const l of leads ?? []) { const c: any = l.companies; const pub = publicationNumber(l.source_url); if (pub && !byCompany.has(c.id)) byCompany.set(c.id, { name: c.name, notice: pub }); }
  const sample = [...byCompany.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, N);
  const budget = await Budget.open(db);
  const startSpend = budget.totalToday;
  console.log(`domainless tender winners: ${byCompany.size} · sample ${sample.length} · spend today before €${startSpend.toFixed(4)} of €${budget.capEur} · this run stops at €${MAX_EUR}`);

  const rows: any[] = [];
  for (const s of sample) {
    const xml = await fetchNoticeXml(s.notice);
    const a = xml ? winnerAddress(xml, s.name) : null;
    if (!a || !(a.city || a.postalCode)) { console.log(`\n${s.name} (${s.notice}): no address in the notice — skipped`); continue; }
    const cc = a.country ? ISO3_TO_2[a.country] ?? a.country : null;
    console.log(`\n${s.name} (${s.notice}) · notice address: ${[a.street, [a.postalCode, a.city].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ')}`);
    const row: any = { name: s.name, city: a.city };
    for (const [arm, input] of [['A name + country', { name: s.name, country: cc }], ['B name + address', { name: s.name, country: cc, address: a }]] as const) {
      if (budget.totalToday - startSpend + 0.1 > MAX_EUR || !budget.canAfford(0.1)) { console.log(`  ${arm}: not run — the run's limit or the daily cap is reached`); row[arm[0]] = null; continue; }
      let r: LookupResult | null = null;
      let err = '';
      try { r = await lookupDomain(input as any, { db, workspaceId, budget, label: `${s.name} (sample ${arm[0]})` }); } catch (e: any) { err = String(e?.message ?? e).slice(0, 80); }
      const v = r?.domain ? await verify(r.domain, a) : '';
      row[arm[0]] = { domain: r?.domain ?? null, eur: r?.eur ?? 0, verified: /prints/.test(v), note: v || err || 'no domain' };
      console.log(`  ${arm}: ${r?.domain ?? 'null'} · €${(r?.eur ?? 0).toFixed(4)} · ${v || err || 'answered no domain'}`);
    }
    rows.push(row);
  }

  const arm = (k: 'A' | 'B') => {
    const ran = rows.filter((r) => r[k]);
    const eur = ran.reduce((t, r) => t + r[k].eur, 0);
    const found = ran.filter((r) => r[k].domain).length;
    const verified = ran.filter((r) => r[k].verified).length;
    return { ran: ran.length, eur, perCompany: ran.length ? eur / ran.length : 0, found, verified, perVerified: verified ? eur / verified : null };
  };
  const A = arm('A'), B = arm('B');
  const disagree = rows.filter((r) => r.A && r.B && r.A.domain !== r.B.domain);
  console.log(`\n=== sample result`);
  console.log(`A name + country : ${A.ran} lookups · €${A.eur.toFixed(4)} · €${A.perCompany.toFixed(4)} a company · domain answered ${A.found} · address verified on the site ${A.verified} · €${A.perVerified?.toFixed(4) ?? '—'} per verified site`);
  console.log(`B name + address : ${B.ran} lookups · €${B.eur.toFixed(4)} · €${B.perCompany.toFixed(4)} a company · domain answered ${B.found} · address verified on the site ${B.verified} · €${B.perVerified?.toFixed(4) ?? '—'} per verified site`);
  console.log(`answers that differ between A and B: ${disagree.length}${disagree.length ? ` — ${disagree.map((r) => `${r.name}: A ${r.A.domain ?? 'null'}${r.A.verified ? ' ✓' : ''} / B ${r.B.domain ?? 'null'}${r.B.verified ? ' ✓' : ''}`).join('; ')}` : ''}`);
  console.log(`this run spent €${(budget.totalToday - startSpend).toFixed(4)} · spend today after €${budget.totalToday.toFixed(4)} of €${budget.capEur}`);
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
