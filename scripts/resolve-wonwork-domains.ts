/**
 * Find the websites of the companies behind open won-work leads that have none — paid, under the daily cap, resumable.
 *
 *   npx tsx --env-file=.env.local scripts/resolve-wonwork-domains.ts [--write] [--limit 200] [--retries-only] [--news-only]
 *
 * Search by name and country, as /api/jobs/resolve-domains does — the notice's address in the query cost 18% more and
 * missed vizoso.net (scripts/domain-lookup-sample.ts) — and use the address afterwards, for free, to check the site.
 *
 * For each company with no domain and fewer than two lookups tried (0033 `domain_lookups`):
 *   1  the winner's own address from its award notice's XML (src/lib/tender/winner-address.ts), free;
 *   2  one lookup (src/lib/domain-lookup.ts): a domain comes back only when a page the model read names the company;
 *   3  the address check: the site's home page or a contact / imprint page prints the notice's postcode or town;
 *   4  the scope: the winner's own site, or its group's (src/lib/site-scope.ts) — colas.com for COLAS FRANCE.
 *
 * --write stores the domain with the 0033 columns — domain_source 'web search', the page read, the check and the address
 * checked, the scope and its reason — and never touches companies.source (until 2026-09-15 a search wrote over it and
 * lost where the company came from). A miss counts one lookup; the second miss is final (careers_status
 * 'no_domain_found'), because the lookup is not deterministic: ANDRES VIZOSO was found once and missed the next time.
 * One lookup per company per run, so a retry is a separate run. Refuses --write until 0033 is applied.
 */
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { Budget } from '../src/lib/cost';
import { crawlWorkspace } from '../src/lib/crawl-workspace';
import { lookupDomain } from '../src/lib/domain-lookup';
import { fetchNoticeXml, publicationNumber, winnerAddress, type WinnerAddress } from '../src/lib/tender/winner-address';
import { leadSource, primaryArticle } from '../src/lib/lead-source';
import { siteScope } from '../src/lib/site-scope';
import { hasDomainProvenance } from '../src/lib/schema-features';
import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE } from '../src/lib/workspace-state';
import { probeAdmin } from '../src/lib/test-data';
import { newsLeadAge, tenderLeadAge } from '../src/lib/lead-age';
import { articlesByLead } from '../src/lib/lead-articles';
import { hasAwardDate } from '../src/lib/schema-features';
import { AGE_UNKNOWN, FRESH_DAYS, ageBucket, discoveryOrder } from '../src/lib/discovery-order';

const write = process.argv.includes('--write');
const retriesOnly = process.argv.includes('--retries-only');
const newsOnly = process.argv.includes('--news-only');
const limitAt = process.argv.indexOf('--limit');
const LIMIT = limitAt > 0 ? Number(process.argv[limitAt + 1]) : 200;
const MAX_LOOKUPS = 2;
const db = probeAdmin();
const ISO3_TO_2: Record<string, string> = { FRA: 'FR', DEU: 'DE', BEL: 'BE', NLD: 'NL', DNK: 'DK', NOR: 'NO', SWE: 'SE', FIN: 'FI', POL: 'PL', CZE: 'CZ', AUT: 'AT', ESP: 'ES', ITA: 'IT', PRT: 'PT', EST: 'EE', LVA: 'LV', LTU: 'LT', HRV: 'HR', SVN: 'SI', SVK: 'SK', ROU: 'RO', BGR: 'BG', HUN: 'HU', IRL: 'IE', GBR: 'GB', LUX: 'LU', GRC: 'GR', CHE: 'CH', CYP: 'CY', MLT: 'MT', ISL: 'IS' };

async function html(url: string) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 LeadScout' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }).catch(() => null);
  return res && res.ok ? await res.text().catch(() => '') : '';
}
const textOf = (h: string) => { const $ = cheerio.load(h); $('script, style, noscript').remove(); return $('body').text().replace(/\s+/g, ' '); };

type Check = 'printed' | 'not_printed' | 'site_did_not_load' | 'no_address';

/** The notice's postcode or town printed on the site's home page or one of its contact / imprint pages. */
async function addressCheck(domain: string, a: WinnerAddress | null): Promise<Check> {
  const wants = [a?.postalCode, a?.city?.split(/[-\s]/)[0]].filter((w): w is string => !!w && w.length >= 3).map((w) => w.toLowerCase());
  if (!wants.length) return 'no_address';
  const home = await html(`https://${domain}`);
  if (!home) return 'site_did_not_load';
  if (wants.some((w) => textOf(home).toLowerCase().includes(w))) return 'printed';
  const $ = cheerio.load(home);
  const links = [...new Set($('a[href]').map((_, x) => $(x).attr('href') ?? '').get().filter((h) => /contact|kontakt|impressum|imprint|mentions|legal|about|over-ons|om-oss|o-nas|chi-siamo|empresa/i.test(h)))].slice(0, 3);
  for (const l of links) {
    const url = l.startsWith('http') ? l : `https://${domain}${l.startsWith('/') ? '' : '/'}${l}`;
    const text = textOf(await html(url)).toLowerCase();
    if (wants.some((w) => text.includes(w))) return 'printed';
  }
  return 'not_printed';
}

(async () => {
  const provenance = await hasDomainProvenance(db);
  if (write && !provenance) { console.log('0033 has not been applied yet: nothing is written. Apply supabase/migrations/0033_domain_provenance.sql first.'); process.exitCode = 2; return; }
  const workspaceId = await crawlWorkspace(db);
  const cols = `id, name, domain, careers_status${provenance ? ', domain_lookups' : ''}`;
  const { data: leads, error } = await db.from('leads').select(`id, source_url, country, companies!inner(${cols}), ${LEAD_STATE_EMBED}`)
    .eq('workspace_id', workspaceId).eq('kind', 'won_work').eq('is_test', false).not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES)
    .is('companies.domain', null).limit(5000) as { data: any[] | null; error: any };
  if (error) throw new Error(error.message);
  const awardCols = (await hasAwardDate(db)) ? ', award_date, award_date_basis' : '';
  const { byLead, error: artErr } = await articlesByLead((leads ?? []).map((l: any) => l.id), awardCols);
  if (artErr) throw new Error(`the dates behind these leads could not be read: ${artErr}`);
  const todo = new Map<string, { id: string; name: string; notice: string | null; leadCountry: string | null; lookups: number; final: boolean; age: number }>();
  for (const l of leads ?? []) {
    // ITEM 27, THE OWNER'S HOLD: --news-only processes ONLY news-sourced won-work leads and skips every
    // tender award. Both kinds live under kind = 'won_work', so this script has always covered them
    // together — and on 2026-09-27 the owner APPROVED the 31 news-sourced companies while HOLDING the 103
    // tender-award ones pending item 29. Running unfiltered would spend on exactly the companies being
    // held. Measured 2026-09-27, the same day: the held population is still EXACTLY 103 companies (none has
    // gained a domain since), and item 29 calls 32 of them municipal on every buyer they have.
    //
    // It is a FILTER over an existing judgement, not a new one: leadSource() already distinguishes the two
    // by source_url a few lines below, for the notice number. Nothing here decides what a lead is.
    //
    // The flag is opt-in rather than the default deliberately. A future run that wants both kinds should
    // say so, and a default that silently changed which population is paid for is how the hold would be
    // lost — the same reasoning that made item 12's admission rule explicit rather than implicit.
    if (newsOnly && leadSource(l.source_url) !== 'news') continue;
    const c: any = l.companies;
    const notice = leadSource(l.source_url) === 'tender' ? publicationNumber(l.source_url) : null;
    // ITEM 17'S AGE, NOT leads.created_at (owner's reprioritisation, 2026-09-27). The obvious basis is the
    // wrong one and it fails silently: the TED backfill ran on 2026-09-13, so ordering on when WE stored a
    // row makes 32 of 32 news and 103 of 103 tender companies look 30 days old or younger, and the
    // reprioritisation becomes a no-op that reports success. On item 17's real age — the award date for a
    // tender, the article's publication for a news lead — the split is 22 of 32 and 23 of 103, which is the
    // reordering the owner actually asked for.
    const art: any = primaryArticle(byLead.get(l.id) ?? [], l.source_url);
    const judged = leadSource(l.source_url) === 'tender'
      ? tenderLeadAge({ awardDate: art?.award_date, awardBasis: art?.award_date_basis, publishedAt: art?.published_at, awardDateRead: !!awardCols })
      : newsLeadAge({ publishedAt: art?.published_at });
    // AGE UNKNOWN SORTS LAST, following latestActivityCompare — the rule this codebase already uses when
    // ordering BY RECENCY, which is exactly what this is. 8 of the 32 news companies have no date at all
    // (their articles carry no published_at), and treating "we do not know" as "brand new" would put them
    // ahead of leads measured to be days old. The default Leads sort treats unknown as fresh; that is right
    // for a list nobody should have to filter, and wrong for deciding what to spend money on first.
    const leadAge = judged.days ?? AGE_UNKNOWN;
    const t = todo.get(c.id) ?? { id: c.id, name: c.name, notice, leadCountry: l.country ?? null, lookups: Number(c.domain_lookups ?? 0), final: c.careers_status === 'no_domain_found', age: AGE_UNKNOWN };
    // A company with one new award and one old one is a FRESH company: the newest signal is the live one.
    t.age = Math.min(t.age, leadAge);
    t.notice ??= notice;
    todo.set(c.id, t);
  }
  const all = [...todo.values()];
  const eligible = all.filter((t) => !t.final && t.lookups < MAX_LOOKUPS && (!retriesOnly || t.lookups >= 1));
  // FRESH FIRST, THEN OLDER, THEN UNKNOWN (owner's decision, 2026-09-27). Same population, same total cost,
  // same eventual coverage — only the order changes, so the opportunities most likely to still be live get
  // real contacts early in a multi-day run rather than at the end of it. The previous tiebreakers are kept
  // underneath rather than replaced: a retry still beats a first look within the same age bucket, and the
  // name still settles a tie, so a run remains deterministic and re-runnable.
  const pending = eligible.sort(discoveryOrder).slice(0, LIMIT);
  const budget = await Budget.open(db);
  const startSpend = budget.totalToday;
  console.log(`won-work companies with no website: ${all.length}${newsOnly ? ' (NEWS-SOURCED ONLY — tender awards held, item 29)' : ''} · never looked up ${all.filter((t) => t.lookups === 0 && !t.final).length} · missed once (a retry is due) ${all.filter((t) => t.lookups === 1 && !t.final).length} · final "not found" ${all.filter((t) => t.final).length} · to look up now: ${pending.length}${retriesOnly ? ' (retries only)' : ''} · spend today €${startSpend.toFixed(4)} of €${budget.capEur} · ${write ? 'writing' : 'dry run — nothing stored'}`);
  console.log(`order: freshest first by item 17's lead age (not when we stored it) — ${eligible.filter((t) => ageBucket(t) === 0).length} at ${FRESH_DAYS} days or younger, ${eligible.filter((t) => ageBucket(t) === 1).length} older, ${eligible.filter((t) => ageBucket(t) === 2).length} with no date (last)`);

  // Without --write nothing is looked up at all: a lookup is paid for whether or not its answer is stored, so a "dry run"
  // that searched would spend the budget and throw the result away. It lists what a --write run would look up.
  if (!write) {
    for (const t of pending) console.log(`  would look up ${t.name} · lookup ${t.lookups + 1} of ${MAX_LOOKUPS}${t.lookups ? ' (retry)' : ''}`);
    console.log(`\nplan only — nothing looked up, nothing spent. About €${(pending.length * 0.023).toFixed(2)} at the measured €0.023 a company; add --write to run it.`);
    return;
  }

  const tally = { looked: 0, retries: 0, found: 0, foundOnRetry: 0, final: 0, printed: 0, notPrinted: 0, didNotLoad: 0, noAddress: 0, group: 0, notFound: 0, errors: 0, stoppedAtCap: 0 };
  for (const t of pending) {
    if (!budget.canAfford(0.05)) { tally.stoppedAtCap = pending.length - tally.looked; console.log(`\nstopped: the daily cap cannot take another lookup — ${tally.stoppedAtCap} left for after 00:00 UTC`); break; }
    const xml = t.notice ? await fetchNoticeXml(t.notice) : null;
    const a = xml ? winnerAddress(xml, t.name) : null;
    const country = (a?.country ? ISO3_TO_2[a.country] ?? a.country : null) ?? t.leadCountry;
    const attempt = t.lookups + 1;
    tally.looked++; if (attempt > 1) tally.retries++;
    try {
      const r = await lookupDomain({ name: t.name, country }, { db, workspaceId, budget, label: t.name });
      const stamp = { domain_lookups: attempt, domain_looked_up_at: new Date().toISOString() };
      if (!r.domain) {
        tally.notFound++;
        const final = attempt >= MAX_LOOKUPS;
        if (final) tally.final++;
        console.log(`  ${t.name} (${country ?? '—'}): no website · lookup ${attempt} of ${MAX_LOOKUPS}${final ? ' · now final' : ' · a retry is due'} · €${r.eur.toFixed(4)}`);
        if (write) await db.from('companies').update({ ...stamp, ...(final ? { careers_status: 'no_domain_found' } : {}) }).eq('id', t.id);
        continue;
      }
      tally.found++; if (attempt > 1) tally.foundOnRetry++;
      const check = await addressCheck(r.domain, a);
      if (check === 'printed') tally.printed++; else if (check === 'not_printed') tally.notPrinted++; else if (check === 'site_did_not_load') tally.didNotLoad++; else tally.noAddress++;
      const { data: holders } = await db.from('companies').select('name').eq('domain', r.domain).neq('id', t.id).limit(3);
      const scope = siteScope({ companyName: t.name, domain: r.domain, winnerCountry: country, sharedWith: (holders ?? []).map((h: any) => h.name) });
      if (scope.scope === 'group') tally.group++;
      const checked = a && (a.city || a.postalCode) ? [a.postalCode, a.city].filter(Boolean).join(' ') : null;
      console.log(`  ${t.name} (${country ?? '—'}): ${r.domain}${attempt > 1 ? ' · found on retry' : ''} · €${r.eur.toFixed(4)} · address ${check.replace(/_/g, ' ')}${checked ? ` (${checked})` : ''} · ${scope.scope === 'group' ? `GROUP SITE — ${scope.reason}` : 'own site'}`);
      if (write) {
        const { error: upErr } = await db.from('companies').update({
          domain: r.domain, domain_source: 'web search', domain_source_url: r.sourceUrl ?? null,
          domain_address_check: check, domain_checked_address: checked, domain_scope: scope.scope, domain_scope_reason: scope.reason, ...stamp,
        }).eq('id', t.id).is('domain', null);
        if (upErr) { tally.errors++; console.log(`    NOT STORED: ${upErr.message}`); }
      }
    } catch (e: any) {
      tally.errors++;
      console.log(`  ${t.name}: lookup failed — ${String(e?.message ?? e).slice(0, 100)} (not counted as a lookup)`);
    }
  }
  const spent = budget.totalToday - startSpend;
  console.log(`\nlooked up ${tally.looked} (retries ${tally.retries}) · website found ${tally.found} (on retry ${tally.foundOnRetry}) · address printed ${tally.printed}, not printed ${tally.notPrinted}, site did not load ${tally.didNotLoad}, notice gave no address ${tally.noAddress} · group site ${tally.group} · no website ${tally.notFound} (now final ${tally.final}) · errors ${tally.errors}`);
  console.log(`this run spent €${spent.toFixed(4)} · €${tally.looked ? (spent / tally.looked).toFixed(4) : '—'} a company · spend today €${budget.totalToday.toFixed(4)} of €${budget.capEur}${tally.stoppedAtCap ? ` · ${tally.stoppedAtCap} still to look up` : ''}`);
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
