/**
 * Item 29's buyer rule, held to the real contracting authorities it will meet.
 *
 *   npx tsx scripts/municipal-buyer-check.ts
 *
 * BOTH ARMS ON EVERY ROW. A filter is two claims, and testing one proves nothing: a pattern list narrowed
 * until it catches nothing passes every "this stays" assertion, and one widened until it catches everything
 * passes every "this is caught" assertion. The names below were read out of `articles.buyers` on 2026-09-27,
 * not invented, so a future edit breaks against the data the rule actually runs on.
 *
 * The hardest assertions here are the ALL-BUYERS rule and the two corrections that produced this file:
 * German gluing its words, and Wissenschaftsstadt Darmstadt being a city rather than a research institute.
 */
import { municipalBuyer, municipalAward, municipalWhy } from '../src/lib/tender/municipal-buyer';

let fail = 0;
const check = (name: string, pass: boolean, detail: string) => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!pass) fail++;
};

// ---- ARM ONE: real municipal buyers, every one of which must be caught --------------------------
const MUNI = [
  'Stadt Sankt Augustin',
  'Stadtverwaltung Ellwangen - Hochbauamt',
  'Gemeinde Bernau am Chiemsee',
  'Gemeente Riemst',
  'FHH Bezirksamt Hamburg-Mitte vertreten durch Sprinkenhof GmbH',
  'Landratsamt Reutlingen, 13/2 Facility Management',
  // The correction that produced this file: this is the CITY of Darmstadt, not a research buyer.
  'Wissenschaftsstadt Darmstadt vertr. durch Darmstädter Bäder GmbH',
  // The three found as MISSES by measuring rather than by reading the pattern back.
  'Stadsbestuur van Harelbeke',
  'SBH | Schulbau Hamburg',
  'Établissement public chargé de la conservation et de la restauration',
];
for (const b of MUNI) {
  const r = municipalBuyer(b);
  check(`caught: ${b.slice(0, 52)}`, !!r, r ? `matched "${r.term}"` : 'NOT MATCHED — a town hall would rank normally');
}

// ---- ARM TWO: real industrial and national buyers, every one of which must SURVIVE --------------
const INDUSTRIAL = [
  'Fluvius System Operator cv (Speciale Sectoren)',
  'Fluvius System Operator cv (Klassieke Sectoren)',
  'De Vlaamse Waterweg nv',
  'Max-Planck-Gesellschaft Abt.III',
  'Deutsches Zentrum für Luft- und Raumfahrt e. V.',
  'Società per le Ferrovie Autolinee Regionali Ticinesi',
  'Stiftung Kaiser-Wilhelm-Gedächtnis-Kirche',
  'JADROLINIJA',
  'Riigilaevastik',
  'Gas Networks Ireland',
  'Energinet Eltransmission A/S',
  'Marinearsenal',
  'Ørsted Bioenergy & Thermal Power',
  // Adjacent categories the owner has NOT ruled on: universities, hospitals and national research bodies
  // are deliberately out of scope, and a first draft that swept them in was wrong to.
  'Edinburgh Napier University',
  'Universitätsklinikum Hamburg-Eppendorf',
];
for (const b of INDUSTRIAL) {
  const r = municipalBuyer(b);
  check(`survives: ${b.slice(0, 52)}`, r === null, r ? `WRONGLY MATCHED on "${r.term}" — real work would be buried` : 'in scope');
}


// ---- THE FIVE PUBLIC SHAPES ADDED 2026-09-27, each with the buyer that earned it ----------------
for (const [b, why] of [
  ['Kreisausschuss Main-Taunus-Kreis, Hochbau- und Liegenschaftsamt', 'a district committee'],
  ['Zweckverband Abwasserreinigung Balingen', 'a municipal special-purpose association'],
  ['LAWOG Gemeinn. Landeswohnungsgen. für OÖ für die Stadt', 'social housing'],
  ['Department of Climate Energy and the Environment', 'a government department'],
  ['Amt für Hochbau und Gebäudewirtschaft', 'a German public office'],
] as [string, string][]) {
  check(`caught (${why}): ${b.slice(0, 40)}`, !!municipalBuyer(b), municipalBuyer(b) ? `matched "${municipalBuyer(b)!.term}"` : 'NOT MATCHED');
}

// ---- STADTWERKE STAYS INDUSTRIAL (owner, 2026-09-27) -------------------------------------------
// Municipally OWNED, but its core business is operating real infrastructure — grids, heat, water — so it
// belongs with Fluvius rather than with a town hall. Core business, not ownership, is the predictor, and the
// costs are asymmetric: a false positive is one irrelevant lead, a false negative holds back a substation job.
for (const b of ['Stadtwerke Prenzlau GmbH', 'Gothaer Stadtwerke ENERGIE GmbH', 'SWM Services GmbH']) {
  check(`survives as industrial: ${b}`, municipalBuyer(b) === null,
    municipalBuyer(b) ? `WRONGLY MATCHED on "${municipalBuyer(b)!.term}" — a real infrastructure operator would be buried` : 'industrial');
}
// Public bodies whose WORK is RFBT's market: ship repair. Public does not mean irrelevant.
for (const b of ['Ministério da Defesa Nacional - Marinha', 'Riigilaevastik']) {
  check(`survives (public but naval): ${b}`, municipalBuyer(b) === null, municipalBuyer(b) ? `WRONGLY MATCHED on "${municipalBuyer(b)!.term}"` : 'industrial');
}
// ---- THE ALL-BUYERS RULE, which is the decision this file exists to protect ---------------------
const mixed = ['Fluvius System Operator cv (Speciale Sectoren)', 'Stadsbestuur van Harelbeke'];
check('a contract shared by a grid operator and a city is NOT ranked down',
  municipalAward(mixed).municipal === false,
  'both buyers are real and only one is municipal, so the work is the grid operator’s');
check('a contract where EVERY buyer is municipal IS ranked down',
  municipalAward(['Stadt Sankt Augustin', 'Gemeinde Bernau am Chiemsee']).municipal === true,
  'no industrial buyer is involved');
check('one municipal buyer alone is ranked down',
  municipalAward(['Stadt Sankt Augustin']).municipal === true, 'the only buyer is a city');

// ---- ABSENCE IS NEVER EVIDENCE -----------------------------------------------------------------
// 8 of the 181 TED articles carry no Contracting authority line at all, and a lead with no buyer on file
// must never be ranked down: not knowing who bought the work is not the same as a town hall buying it.
check('no buyer on file is NOT ranked down', municipalAward([]).municipal === false, 'empty list');
check('null buyers is NOT ranked down', municipalAward(null).municipal === false, 'null, as before 0057 was applied');
check('a blank string is not a buyer', municipalAward(['   ']).municipal === false, 'whitespace only');

// ---- THE VERDICT SAYS WHY, so a lead that sorted lower can be explained ------------------------
const v = municipalAward(['Stadt Sankt Augustin']);
check('a ranked-down lead states its buyer', (municipalWhy(v) ?? '').includes('Stadt Sankt Augustin'),
  JSON.stringify(municipalWhy(v)));
check('an ordinary lead has no such line', municipalWhy(municipalAward(['Gas Networks Ireland'])) === null, 'null');

console.log(`\nmunicipal buyer: ${fail ? `${fail} FAILED` : 'all checks passed'}`);
if (fail) process.exitCode = 1;
