/**
 * Item 21, read only: which won-work leads gained a contact between two census files.
 *
 *   npx tsx scripts/wonwork-contacts-compare.ts .cache/wonwork-contacts-before.json .cache/wonwork-contacts-after.json
 *
 * "A contact" as the census defines it: a named person with an email or phone (the quoted person or someone from the
 * company's own site), or the company's switchboard or general email. Broken down by tender award, news with a quoted
 * person, news without; quoted people who gained a detail are counted on their own.
 */
import { readFileSync } from 'fs';

const [a, b] = process.argv.slice(2);
const before: any[] = JSON.parse(readFileSync(a, 'utf8'));
const after = new Map((JSON.parse(readFileSync(b, 'utf8')) as any[]).map((r) => [r.id, r]));
const sets = ['tender', 'news_quoted', 'news_none'];
for (const s of sets) {
  const rows = before.filter((r) => r.set === s);
  const gained = rows.filter((r) => !r.hasContact && after.get(r.id)?.hasContact);
  const lost = rows.filter((r) => r.hasContact && after.get(r.id) && !after.get(r.id).hasContact);
  const quotedGained = s === 'news_quoted' ? rows.filter((r) => (after.get(r.id)?.quotedReachable ?? 0) > r.quotedReachable).length : 0;
  const companies = new Set(gained.map((r) => r.company_id));
  const how = gained.map((r) => { const x = after.get(r.id); return [x.quotedReachable > r.quotedReachable ? 'quoted person' : null, x.companyPeople > r.companyPeople ? 'site person' : null, x.switchboard && !r.switchboard ? 'switchboard' : null, x.general && !r.general ? 'general email' : null].filter(Boolean).join('+'); });
  const tally: Record<string, number> = {};
  for (const h of how) tally[h || 'other'] = (tally[h || 'other'] ?? 0) + 1;
  console.log(`${s}: ${rows.length} leads · had a contact ${rows.filter((r) => r.hasContact).length} · gained one ${gained.length} (${companies.size} companies) · lost one ${lost.length}${s === 'news_quoted' ? ` · quoted person gained an email or phone on ${quotedGained} lead(s)` : ''} · how: ${JSON.stringify(tally)}`);
  for (const r of gained.slice(0, 12)) console.log(`    ${r.company}`);
}
const gainedAll = before.filter((r) => !r.hasContact && after.get(r.id)?.hasContact);
console.log(`total: ${gainedAll.length} of ${before.length} leads gained a contact they did not have`);
// Named person vs a company's front door. A lead counts as named when, after, someone with an email or phone is on it or
// its company (census files from before 2026-09-15 08:30 lack the field, so it is recomputed where missing).
const named = (x: any) => (x.namedReachable ?? ((x.quotedReachable ?? 0) > 0 ? 1 : 0)) > 0;
const gainedNamed = gainedAll.filter((r) => named(after.get(r.id)));
const gainedGeneric = gainedAll.filter((r) => !named(after.get(r.id)));
console.log(`of those: a named person with an email or phone ${gainedNamed.length} · only a switchboard or general email ${gainedGeneric.length}`);
for (const s of sets) {
  const g = gainedAll.filter((r) => r.set === s);
  if (g.length) console.log(`  ${s}: named ${g.filter((r) => named(after.get(r.id))).length} · generic only ${g.filter((r) => !named(after.get(r.id))).length}`);
}
const namedNow = [...after.values()].filter(named).length;
console.log(`leads with a named, reachable person after: ${namedNow} of ${after.size} (before: ${before.filter(named).length})`);
