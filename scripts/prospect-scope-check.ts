/**
 * Item 27's permanent scope rule, held to real names from the real population.
 *
 *   npx tsx scripts/prospect-scope-check.ts
 *
 * BOTH ARMS ON EVERY ROW, because a filter is two claims and testing one proves nothing: the institutions
 * must be EXCLUDED, and the contractors must SURVIVE. A pattern list narrowed until it catches nothing
 * passes every "is this kept" assertion, and a list widened until it catches everything passes every "is
 * this dropped" assertion. Only both together say the rule works.
 *
 * Every name below was read out of the live companies table on 2026-09-26, not invented, so a future edit
 * that breaks the rule breaks it against the data it will actually meet.
 */
import { nonProspect, keptBySite } from '../src/lib/prospect-scope';

let fail = 0;
const check = (name: string, pass: boolean, detail: string) => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!pass) fail++;
};

// ---- ARM ONE: the institutions the owner ruled out, all real rows ------------------------------
const OUT: [string, string][] = [
  ['Bank of Ireland', 'bank / finance'],
  ['ABN AMRO BANK', 'bank / finance'],
  ['Miller Insurance Brokers', 'bank / finance'],
  ['Gard Marine & Energy Insurance Denmark Branch', 'bank / finance'],
  ['Asters Law Firm', 'law'],
  ['Edinburgh Napier University', 'academic'],
  ['Charles University of Prague', 'academic'],
  ['Flensburg Hochschule', 'academic'],
  ['Vilnius Academy of Arts', 'academic'],
  ['National Maritime College of Ireland', 'academic'],
  ['Danish Wind Power Academy', 'academic'],
  ['Ålands Landskapsregering', 'government / public'],
  ['Ministry of Energy and Energy Industries of Trinidad and Tobago', 'government / public'],
  ['Royal Danish Embassy', 'embassy / consulate'],
  ['Embassy of Denmark in Korea', 'embassy / consulate'],
  ['Austrian Wind Energy Association', 'association / body'],
  ['Ukrainian Wind Energy Association', 'association / body'],
  ['International Marine Contractors Association', 'association / body'],
  ['Humberside Offshore Training Association', 'association / body'],
  ['Bulgarian Society for the Protection of Birds', 'association / body'],
];
for (const [name, category] of OUT) {
  const r = nonProspect(name);
  check(`excluded: ${name}`, !!r && r.category === category, r ? `${r.category} on "${r.term}"` : 'KEPT — the rule missed it');
}

// A SECOND RECORDED MISS, and this one is a GENUINE investment firm rather than a false alarm. HAL
// Investments B.V. really is a Dutch investment company, and removing "investments" means this rule no
// longer catches it. That is accepted deliberately: the word was removed because it had a 0% true-positive
// and 100% false-positive rate on the 145-company QUEUE, and HAL Investments is not in that queue — verified,
// not assumed, by scanning every queue member for a finance shape (capital, partners, equity, ventures,
// fund, holdings, asset, invest*, financ*, trust) and finding none. So what excludes it is the sector-and-ops
// predicate, which is the point: this rule is belt-and-braces over a working queue, not the queue itself.
check('HAL Investments is a KNOWN, DELIBERATE miss after "investments" was removed',
  nonProspect('HAL Investments B.V.') === null,
  'not excluded by name — it is absent from the 145-company queue, which the predicate is what achieves');

// A RECORDED MISS, asserted so nobody closes it with a dangerous pattern. "BayernLB" is a Landesbank and
// contains no word this rule matches — "LB" is the abbreviation, and \bLB\b would hit real company names. The
// design says a missed bank costs one lookup at EUR 0.023 while an over-matched shipyard is silently dropped
// from the product, so this stays missed ON PURPOSE. What actually stops it is the QUEUE, not this rule: a
// Landesbank does not carry one of the seven sectors, which is the whole reason this is belt-and-braces.
check('BayernLB is a KNOWN, DELIBERATE miss of this rule', nonProspect('BayernLB') === null,
  'not excluded by name — the sector predicate is what keeps it out of the queue');
check('but the full word IS caught', !!nonProspect('Landesbank Baden-Wuerttemberg'),
  '"landesbank" matches as a whole word, without the risk of matching "LB"');

// An industrial WORD must not rescue a trade body. This is the half that would quietly undo the rule: four
// of the associations above read offshore, marine or wind, and "any industrial word wins" keeps them all.
check('an industrial word does not rescue a trade body',
  !!nonProspect('International Marine Contractors Association') && !!nonProspect('Ukrainian Wind Energy Association'),
  'both still excluded despite "Marine" and "Wind" in the name');

// ---- ARM TWO: the companies that must SURVIVE --------------------------------------------------
const IN = [
  // The named exception: "authority" matches, a port contracts trades, so the site word wins.
  'Tarragona Port Authority',
  'Salacgriva port authority',
  'Liepaja SEZ authority/Port of Liepaja',
  'Port of Kokkola',
  // Ordinary prospects from the 145-company queue and the wider population.
  'Ocean Winds', 'TenneT TSO', 'IBERDROLA', 'Severfield', 'Fred. Olsen Renewables',
  'Vestas North Europe', 'Saitec Offshore Technologies', 'Brand Energy & Infrastructure',
  'Nordex Energy SE & CO', 'SPIE Wind Germany', 'KCI the Engineers', 'Gurit Wind System',
  'Astilleros de SantanderU.', 'BigLift Shipping B.V.', 'Baltic Diving Solutions Sp. z o.o.',
  'COOEC-Fluor Heavy Industries Co.', 'Atlantique Offshore Energy', 'Aurora Offshore Engineering',
  // Names close to an excluded pattern that must NOT trip it: a brand, not a category.
  'Banke Accessory Drives', 'Fairbanks Morse', 'Bassoe Technology',
  // THE WORD "investments" WAS REMOVED 2026-09-26 and this assertion is what stops it coming back. Cubico is
  // a renewables ASSET OWNER with sector offshore_wind and an ops-relevant contact: it passed the strong
  // predicate and the name rule was the only thing excluding it. Measured over the whole 145-company queue,
  // that word had a 0% true-positive rate and a 100% false-positive rate.
  'Cubico Sustainable Investments',
  'Copenhagen Infrastructure Partners',
];
for (const name of IN) {
  const r = nonProspect(name);
  check(`kept: ${name}`, r === null, r ? `EXCLUDED as ${r.category} on "${r.term}" — over-match` : 'in scope');
}

// The port exception must be REPORTABLE, not just silent: a name kept despite looking institutional says why.
check('a port authority records WHY it was kept', keptBySite('Tarragona Port Authority') !== null,
  `keptBySite = ${JSON.stringify(keptBySite('Tarragona Port Authority'))}`);
check('an ordinary contractor has no such note', keptBySite('Ocean Winds') === null, 'null, as it never matched a category');

// An empty or missing name is for the PREDICATE to judge, not this rule — it must not exclude on nothing.
check('an empty name is not excluded by this rule', nonProspect('') === null && nonProspect(null) === null, 'null for both');

console.log(`\nprospect scope: ${fail ? `${fail} FAILED` : 'all checks passed'}`);
if (fail) process.exitCode = 1;
