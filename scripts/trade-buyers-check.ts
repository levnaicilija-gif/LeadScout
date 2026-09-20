/**
 * The buyer allowlist, held to both arms: the names it must catch, and the names it must never.
 *
 *   npx tsx scripts/trade-buyers-check.ts
 *
 * No database, no network, no model call — pure rules against fixed strings, so it belongs in the
 * release gate beside `company-identity-check` and `cpv-check`.
 *
 * WHY BOTH ARMS. A pattern narrowed until it catches nothing still passes every "it matched" test,
 * which is how item 5's screening dedupe came to swallow the very question it was taught to write
 * (CLAUDE.md). So every entry is tested against the REAL buyer names it was derived from, and the
 * whole list is tested against real municipal, roads, rail and schools-estate buyers taken from the
 * same derivation — the ones the owner deliberately excluded. A stem that starts matching a town
 * council puts back exactly the noise this list exists to remove, and that is the failure that would
 * matter most, so it is the one asserted hardest.
 */
import { TRADE_BUYERS, tradeBuyerFor, normalizeBuyer } from '../src/lib/tender/buyers';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

/** Real names, exactly as TED filed them, that each entry must catch. */
const MUST_MATCH: [string, string][] = [
  ['Energinet Eltransmission A/S', 'energinet'],
  ['Energinet', 'energinet'],
  ['Energinet Elsystemansvar A/S', 'energinet'],
  ['N1 A/S', 'n1 a s'],
  ['CTR I/S', 'ctr i s'],
  ['Udviklingsselskabet By & Havn I/S', 'by havn'],
  ['I/S Vestforbrænding og datterselskaber', 'vestforbraending'],
  ['Kredsløb Transmission A/S', 'kredsloeb transmission'],
  ['N.V. Nederlandse Gasunie', 'nederlandse gasunie'],
  ['TenneT TSO B.V.', 'tennet'],
  ['TenneT TSO GmbH', 'tennet'],
  ['Fluvius System Operator cv (Speciale Sectoren)', 'fluvius'],
  ['Fluvius System Operator cv (Klassieke Sectoren)', 'fluvius'],
  ['De Vlaamse Waterweg nv', 'vlaamse waterweg'],
  ['Haven van Antwerpen-Brugge, NV van publiek recht', 'haven van antwerpen'],
  ['Ellevio AB', 'ellevio'],
  ['Jönköping Energi AB', 'joenkoeping energi'],
  ['Stadtwerke München GmbH', 'stadtwerke muenchen'],
  ['EnBW Hohe See GmbH & Co. KG', 'enbw'],
  ['EnBW Albatros GmbH & Co. KG', 'enbw'],
  ['Stromnetz Berlin GmbH', 'stromnetz berlin'],
  ['Marinearsenal', 'marinearsenal'],
  ['Marinearsenal Warnowwerft', 'marinearsenal'],
  ['N-ERGIE Aktiengesellschaft', 'n ergie'],
];

/**
 * Real buyers from the same derivation that the list must leave alone: councils, regions, roads,
 * rail, airports, state property and schools estates. These are the control — the list is only
 * worth having while every one of them comes back undefined.
 */
const MUST_NOT_MATCH = [
  // Denmark
  'Vejdirektoratet', 'Banedanmark', 'Silkeborg Kommune', 'Københavns Kommune', 'Aarhus Kommune',
  'Region Nordjylland', 'Region Syddanmark', 'Frederiksberg Kommune', 'Miljøstyrelsen',
  'Danmarks Tekniske Universitet', 'Københavns Lufthavne A/S', 'DSB',
  'Forsvarsministeriets Materiel- og Indkøbsstyrelse',
  // Norway — none of its top buyers are ours, which is the point
  'STATSBYGG', 'Statens vegvesen', 'Forsvarsbygg', 'Helse Sør-Øst RHF', 'SYKEHUSINNKJØP HF',
  'Trondheim kommune', 'Sarpsborg kommune', 'Rogaland fylkeskommune', 'Oslo kommune v/ Oslobygg KF',
  // Netherlands
  'Rijksvastgoedbedrijf', 'ProRail B.V.', 'Gemeente Den Haag', 'Gemeente Utrecht',
  'Gemeente Amsterdam, Ingenieursbureau', 'Gemeente Rotterdam', 'Staatsbosbeheer',
  'Technische Universiteit Delft', 'Ministerie van Defensie',
  // Belgium
  'Vlaamse Overheid', 'Infrabel nv', 'NMBS', 'Antwerpen', 'Université de Liège',
  'Katholieke Universiteit te Leuven', 'Federale Politie',
  // Sweden
  'Trafikverket Myndighet', 'Swedavia AB', 'Statens fastighetsverk', 'Norrköpings kommun',
  'Uppsala kommun', 'Umeå kommun', 'Västra Götalandsregionen', 'Aktiebolaget Svenska Bostäder',
  // Germany
  'DB InfraGO AG – Geschäftsbereich Fahrweg (Bukr 16)', 'SBH | Schulbau Hamburg',
  'Landeshauptstadt München, Baureferat', 'Die Autobahn GmbH des Bundes - NL Südbayern',
  'Vermögen und Bau Baden-Württemberg, Amt Tübingen', 'Staatliches Bauamt München 2',
  'Münchner Wohnen GmbH', 'Stadt Münster - Zentrale Rechtsdienstleistungen', 'Landkreis Rottal-Inn',
  'Fraunhofer-Gesellschaft zur Förderung der angewandten Forschung', 'Stadt Göttingen',
  // Deferred water utilities: right kind of buyer, mostly civil trench work (owner 2026-09-20).
  // They must now be left alone exactly like a council, and this arm is what proves it.
  'NOVAFOS A/S', 'Aquafin NV', 'Farys', 'Vlaamse Maatschappij voor Watervoorziening cvba (De Watergroep)',
  // Near misses: a council whose name contains a word an entry also contains.
  'Stadtwerke Prenzlau GmbH', 'Gothaer Stadtwerke ENERGIE GmbH', 'Stadt Energiestadt',
  'Kommune Havnegade 1', 'Vlaamse Overheid Departement Omgeving',
];

console.log('--- every entry catches the names it was derived from ---');
for (const [name, expected] of MUST_MATCH) {
  const hit = tradeBuyerFor(name);
  check(hit?.match === expected, `"${name.slice(0, 46)}" -> ${expected}`, hit ? (hit.match === expected ? '' : `matched ${hit.match} instead`) : 'matched nothing');
}

console.log('\n--- and catches nobody the owner excluded ---');
for (const name of MUST_NOT_MATCH) {
  const hit = tradeBuyerFor(name);
  check(!hit, `"${name.slice(0, 52)}" is left alone`, hit ? `MATCHED "${hit.match}" (${hit.label})` : '');
}

console.log('\n--- the list itself ---');
const seen = new Set<string>();
for (const b of TRADE_BUYERS) {
  const m = normalizeBuyer(b.match);
  check(m.length >= 5 || !!b.shortOk, `"${b.match}" is long enough to be a safe stem, or says why not`, m.length >= 5 ? "" : (b.shortOk ?? `${m.length} chars and no reason given`));
  check(!seen.has(m), `"${b.match}" appears once`, seen.has(m) ? 'duplicate entry' : '');
  seen.add(m);
  check(b.why.trim().length > 40, `"${b.match}" records why it is here`, `${b.why.trim().length} chars`);
  check(/\d/.test(b.why), `"${b.match}" cites a number — awards counted or a notice read`, b.why.slice(0, 50));
}
// No entry may be a substring of another: the first would shadow the second and the second would
// never be reached, which is silent rather than wrong-looking.
for (const a of TRADE_BUYERS) {
  for (const b of TRADE_BUYERS) {
    if (a === b) continue;
    const na = normalizeBuyer(a.match);
    const nb = normalizeBuyer(b.match);
    check(!(nb.includes(` ${na} `) || nb.startsWith(`${na} `) || nb.endsWith(` ${na}`) || nb === na),
      `"${b.match}" is not shadowed by "${a.match}"`);
  }
}

console.log(failures ? `\ntrade buyers: ${failures} FAILED` : `\ntrade buyers: all checks passed (${TRADE_BUYERS.length} entries)`);
process.exit(failures ? 1 : 0);
