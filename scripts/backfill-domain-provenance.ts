/**
 * After 0033: fill what SQL could not for websites found by search — the award notice's address the site was checked
 * against, and whether the site is the winner's own or its group's. Report only without --write.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-domain-provenance.ts [--write]
 *
 * For every company with domain_source 'web search': the winner's address is re-read from its award notice's XML (free,
 * src/lib/tender/winner-address.ts) into domain_checked_address; siteScope (src/lib/site-scope.ts) sets domain_scope and
 * domain_scope_reason, including whether the same domain is on file for a differently named company. The address check
 * itself (printed / not printed / …) was moved across by the migration and is not redone here.
 */
import { createClient } from '@supabase/supabase-js';
import { siteScope } from '../src/lib/site-scope';
import { fetchNoticeXml, publicationNumber, winnerAddress } from '../src/lib/tender/winner-address';
import { hasDomainProvenance } from '../src/lib/schema-features';

const write = process.argv.includes('--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ISO3_TO_2: Record<string, string> = { FRA: 'FR', DEU: 'DE', BEL: 'BE', NLD: 'NL', DNK: 'DK', NOR: 'NO', SWE: 'SE', FIN: 'FI', POL: 'PL', CZE: 'CZ', AUT: 'AT', ESP: 'ES', ITA: 'IT', PRT: 'PT', EST: 'EE', LVA: 'LV', LTU: 'LT', HRV: 'HR', SVN: 'SI', SVK: 'SK', ROU: 'RO', BGR: 'BG', HUN: 'HU', IRL: 'IE', GBR: 'GB', LUX: 'LU', GRC: 'GR', CHE: 'CH' };

(async () => {
  if (!(await hasDomainProvenance(db))) { console.log('0033 has not been applied yet — nothing to backfill. Apply supabase/migrations/0033_domain_provenance.sql first.'); process.exitCode = 2; return; }
  const { data: cos, error } = await db.from('companies').select('id, name, domain, source, source_url, domain_address_check, domain_scope').eq('domain_source', 'web search').not('domain', 'is', null).limit(5000);
  if (error) throw new Error(error.message);
  const domains = [...new Set((cos ?? []).map((c) => c.domain))];
  const holders = new Map<string, string[]>();
  for (let i = 0; i < domains.length; i += 150) {
    const { data } = await db.from('companies').select('name, domain').in('domain', domains.slice(i, i + 150));
    for (const r of data ?? []) holders.set(r.domain, [...(holders.get(r.domain) ?? []), r.name]);
  }
  let bad = 0; const tally = { own: 0, group: 0, address: 0 };
  console.log(`companies with a website found by search: ${(cos ?? []).length} · ${write ? 'writing' : 'report only'}`);
  for (const c of cos ?? []) {
    const notice = c.source === 'ted award notice' ? publicationNumber(c.source_url) : null;
    const xml = notice ? await fetchNoticeXml(notice) : null;
    const a = xml ? winnerAddress(xml, c.name) : null;
    const checked = a && (a.city || a.postalCode) ? [a.postalCode, a.city].filter(Boolean).join(' ') : null;
    const s = siteScope({ companyName: c.name, domain: c.domain, winnerCountry: a?.country ? ISO3_TO_2[a.country] ?? a.country : null, sharedWith: (holders.get(c.domain) ?? []).filter((n) => n !== c.name) });
    tally[s.scope]++; if (checked) tally.address++;
    console.log(`  ${c.name} · ${c.domain} · check ${c.domain_address_check ?? '—'}${checked ? ` against ${checked}` : ''} · ${s.scope}${s.reason ? ` — ${s.reason}` : ''}`);
    if (!write) continue;
    const { error: upErr } = await db.from('companies').update({ domain_checked_address: checked, domain_scope: s.scope, domain_scope_reason: s.reason }).eq('id', c.id);
    if (upErr) { bad++; console.log(`    FAILED: ${upErr.message}`); }
  }
  console.log(`\nown site ${tally.own} · group site ${tally.group} · notice address found ${tally.address}${write ? ` · problems ${bad}` : ' · report only — add --write'}`);
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
