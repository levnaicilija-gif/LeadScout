/**
 * The award gate, held to both arms: what it must keep, and what it must still reject.
 *
 *   npx tsx scripts/tender-gate-check.ts
 *
 * No database, no network, no model call — `awardDecision` against fixed records, so this belongs in
 * the release gate beside `trade-buyers-check` and `company-identity-check`.
 *
 * WHY BOTH ARMS. "More awards came through" is not evidence the filter improved; it is equally the
 * signature of a filter that stopped filtering. Every case below is a REAL shape taken from the
 * 60-day TED measurement of 2026-09-20/21 — the buyers, the codes and the winners are the ones the
 * live API returned — and the rejections matter more than the keeps, because the failure this rule
 * could introduce is a town council arriving as a won-work lead.
 *
 * The case that started all of this is the first one: Energinet Eltransmission under the bare
 * 45000000, which the CPV rule drops and which is a Danish transmission contract won by NCC.
 */
import { awardDecision } from '../src/lib/tender/ingest';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const decide = (mainCpv: string[], buyers: string[]) => awardDecision({ mainCpv, buyers } as any);
const kept = (d: ReturnType<typeof decide>) => d.by !== null;

console.log('--- KEPT: an allowlisted buyer under a generic code the CPV rule alone drops ---');
for (const [cpv, buyer, winner] of [
  ['45000000', 'Energinet Eltransmission A/S', 'NCC DANMARK AS'],
  ['45000000', 'Energinet Eltransmission A/S', 'Caverion Danmark A/S'],
  ['45230000', 'Energinet Eltransmission A/S', 'Entreprenørfirmaet Nordkysten'],
  ['45000000', 'N1 A/S', 'M.H. ENTREPRISE P/S'],
  ['45231113', 'I/S Vestforbrænding og datterselskaber', 'LOGSTOR DENMARK HOLDING ApS'],
  ['45000000', 'Haven van Antwerpen-Brugge, NV van publiek recht', 'TM Crusoe'],
  ['45240000', 'De Vlaamse Waterweg nv', 'nv Besix'],
  ['50000000', 'Marinearsenal Warnowwerft', 'Peene-Werft GmbH & Co. KG'],
  ['45315300', 'Ellevio AB', 'Linjemontage i Grästorp Aktiebolag'],
  ['45000000', 'Stadtwerke München GmbH', 'Glass GmbH Bauunternehmung'],
  ['45000000', 'TenneT TSO GmbH', 'Safelane Global GmbH'],
  ['45210000', 'Jönköping Energi AB', 'Brixly'],
] as const) {
  const d = decide([cpv], [buyer]);
  check(d.by === 'buyer', `${cpv} ${buyer.slice(0, 40)}`,
    d.by === 'cpv' ? 'kept by CPV, so this case proves nothing about the buyer rule' : d.by ? '' : 'DROPPED');
}

console.log('\n--- REJECTED: the same generic codes, buyers that are not ours ---');
for (const [cpv, buyer] of [
  ['45000000', 'Trondheim kommune'],
  ['45000000', 'Gemeente Krimpenerwaard'],
  ['45000000', 'Stadt Speyer'],
  ['45000000', 'STATSBYGG'],
  ['45000000', 'Vejdirektoratet'],
  ['45000000', 'Banedanmark'],
  ['45000000', 'Trafikverket Myndighet'],
  ['45000000', 'DB InfraGO AG – Geschäftsbereich Fahrweg (Bukr 16)'],
  ['45000000', 'SBH | Schulbau Hamburg'],
  ['45000000', 'Rijksvastgoedbedrijf'],
  ['45000000', 'Aquafin NV'],
  ['45232411', 'Aquafin NV'],
  ['45000000', 'Kredsløb A/S'],
  ['45000000', 'Hälsohögskolan i Jönköping AB'],
] as const) {
  const d = decide([cpv], [buyer]);
  check(!kept(d), `${cpv} ${buyer.slice(0, 44)} is left alone`,
    d.by === 'buyer' ? `MATCHED "${d.buyerHit?.match}"` : d.by === 'cpv' ? 'kept by CPV' : '');
}

console.log('\n--- REJECTED: our own buyers, but the contract is not work ---');
for (const [cpv, buyer, what] of [
  ['66522000', 'Energinet', 'group life insurance'],
  ['66510000', 'Energinet', 'insurance'],
  ['60424120', 'Energinet Eltransmission A/S', 'helicopter services'],
  ['71000000', 'Energinet', 'consultancy'],
  ['71311000', 'Energinet', 'engineering consultancy'],
  ['31170000', 'Energinet Eltransmission A/S', 'transformer supply'],
  ['32420000', 'Energinet', 'network equipment'],
  ['24111600', 'N.V. Nederlandse Gasunie', 'chemicals'],
] as const) {
  const d = decide([cpv], [buyer]);
  check(!kept(d), `${cpv} ${buyer.slice(0, 32)} (${what})`,
    d.by ? 'KEPT — the division guard failed' : '');
}

console.log('\n--- unchanged: the CPV rule still decides on its own ---');
check(decide(['45262100'], ['Stadt Oelde']).hits.length > 0, 'a trade code keeps an award whatever the buyer');
check(!decide(['79620000'], ['Stadt Oelde']).hits.length, 'a non-trade code with no allowlisted buyer is dropped');
const both = decide(['45262100'], ['Energinet']);
check(both.by === 'cpv', 'an award matching BOTH is counted as a CPV keep, not a buyer keep', `by=${both.by}`);
check(decide([], ['Energinet']).by === null, 'a notice stating no main classification is not kept on the buyer alone');

console.log(failures ? `\ntender gate: ${failures} FAILED` : '\ntender gate: all checks passed');
process.exit(failures ? 1 : 0);
