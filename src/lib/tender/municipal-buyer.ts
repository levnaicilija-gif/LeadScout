/**
 * Is a tender award's work for a town council rather than for industry? Item 29.
 *
 * WHY THE BUYER AND NOT THE CODE. Item 12 admits a notice when its procedure's MAIN CPV is on the 42-code
 * trade list, which asks what the work IS and never what it is FOR. Measured 2026-09-27: of 167 open award
 * leads, 66 classify as Other/Uncategorized, and 55 of those carry scaffolding (45262100) or structural
 * steelworks (45223210) — won by German scaffolding firms on municipal building work. The code cannot separate
 * a scaffold on a town hall from a scaffold on a substation. The BUYER can, and it is already stored:
 * `articles.buyers` (0057), copied verbatim from the notice's own "Contracting authority:" lines.
 *
 * THIS IS A JUDGEMENT COMPUTED ON READ, NEVER STORED. The fact is the buyer's name; whether that name is a
 * municipality is this function's opinion, and opinions go stale where facts do not — the same split already
 * proved by lead age, compound signals and certificate-only. Change a pattern here and every lead is
 * re-judged on the next render, with no backfill and no column to clear.
 *
 * ALL BUYERS MUST BE MUNICIPAL, NOT MERELY ONE (owner's decision, 2026-09-27). 14 of the 173 backfilled
 * notices name more than one buyer, and the case that settled it is real:
 *
 *   ["Fluvius System Operator cv (Speciale Sectoren)", "Stadsbestuur van Harelbeke"]
 *
 * A Belgian grid operator and a city administration on one contract. That is grid work the city happens to
 * co-procure, and ranking it down would defeat the entire purpose of the rule.
 *
 * NO MODEL CALL. Pure string work on text already in the table, matching item 12's own EUR 0 design.
 *
 * CURATED, NOT DERIVED — and `buyers.ts` already explains why for the mirror-image problem: `canonCompany`
 * was tested for that job and is unsafe in BOTH directions. The same discipline applies here, and the first
 * two attempts at this rule proved it twice over:
 *
 *   - A \b-anchored pattern caught only 19% of municipal buyers, because GERMAN GLUES ITS WORDS: it missed
 *     Stadtverwaltung Ellwangen, Bezirksamt Hamburg-Mitte and Landratsamt Reutlingen.
 *   - Then `Wissenschaftsstadt Darmstadt` was wrongly written off as a research buyer. It is the OFFICIAL
 *     NAME OF THE CITY OF DARMSTADT, so it must match — which is why -stadt is matched as a SUFFIX rather
 *     than as a whole word.
 *
 * KNOWN RESIDUAL, recorded rather than hidden: this rule catches 27 of the 48 no-website Other-classified
 * tender leads. The other 21 are genuinely industrial — Fluvius, De Vlaamse Waterweg, Max-Planck-Gesellschaft,
 * Deutsches Zentrum für Luft- und Raumfahrt, the Ticino regional railway, a church foundation — and must stay.
 * Adjacent categories are DELIBERATELY out of scope because the owner ruled on municipal buyers only:
 * universities, hospitals and national research institutes are not matched here, and a first draft that swept
 * them in was wrong to. If they should rank down, that is its own decision.
 */

/**
 * Each entry carries the real buyer that put it here, exactly as `buyers.ts` does. A pattern with no example
 * behind it is a guess, and a guess in this file silently buries a real lead or surfaces a town hall.
 */
const MUNICIPAL: { re: RegExp; why: string }[] = [
  // German. -stadt is a SUFFIX: city names glue onto it, and the city's own formal title often does too.
  { re: /stadt\b/i, why: 'Stadt Sankt Augustin; Wissenschaftsstadt Darmstadt, which IS the city of Darmstadt' },
  { re: /stadtverwaltung/i, why: 'Stadtverwaltung Ellwangen - Hochbauamt' },
  { re: /\bgemeinde\b|samtgemeinde|verbandsgemeinde|ortsgemeinde/i, why: 'Gemeinde Bernau am Chiemsee' },
  { re: /bezirksamt/i, why: 'FHH Bezirksamt Hamburg-Mitte vertreten durch Sprinkenhof GmbH' },
  { re: /landratsamt|landkreis|kreisverwaltung/i, why: 'Landratsamt Reutlingen, 13/2 Facility Management' },
  // Hamburg files school building under a city body with no municipal word in it at all; the city is in
  // the name rather than the type, so this is matched by name. Found as a MISS on 2026-09-27.
  { re: /schulbau\b/i, why: 'SBH | Schulbau Hamburg — the city school-building authority' },
  // Dutch and Flemish. `Stadsbestuur` is city administration; a \bstad\b pattern cannot reach it.
  { re: /\bgemeente\b/i, why: 'Gemeente Riemst' },
  { re: /stadsbestuur|\bstad\s/i, why: 'Stadsbestuur van Harelbeke, co-buyer with Fluvius — found as a MISS' },
  { re: /\bprovincie\b/i, why: 'Dutch and Belgian provincial authorities' },
  // Nordic.
  { re: /\bkommune\b|\bkommunen\b|\bkommun\b|kommunes\b/i, why: 'Danish and Norwegian municipalities' },
  // Romance.
  { re: /ayuntamiento|\bcomune\b|\bmunicipi/i, why: 'Spanish, Italian and Catalan municipalities' },
  { re: /\bville de\b|\bmairie\b|communaut[ée] (de|d\x27)/i, why: 'French communes and inter-communal bodies' },
  // A French public establishment: public by its own words, though not a commune.
  { re: /[ée]tablissement public/i, why: 'Etablissement public charge de la conservation... — found as a MISS' },
  // FIVE SHAPES ADDED 2026-09-27 after re-measuring the 103 held tender companies against this rule: nine of
  // the 76 it called "industrial" had ONLY public buyers, and both Hess Gerüstbau rows were among them — a
  // scaffolding firm that would have been unblocked for paid website discovery on the strength of two public
  // buyers, which is the outcome item 29 exists to prevent arriving through the back door.
  { re: /kreisausschuss/i, why: 'Kreisausschuss Main-Taunus-Kreis, Hochbau- und Liegenschaftsamt — a district committee' },
  { re: /zweckverband/i, why: 'Zweckverband Abwasserreinigung Balingen — a municipal special-purpose association' },
  { re: /wohnungsgen|landeswohnung/i, why: 'LAWOG Gemeinn. Landeswohnungsgen. für OÖ — social housing' },
  { re: /\bdepartment of\b/i, why: 'Department of Climate Energy and the Environment (Ireland), twice' },
  { re: /\bamt f[üu]r\b/i, why: 'German public offices; paired with the Liegenschaftsamt case above' },
  //
  // STADTWERKE IS DELIBERATELY *NOT* HERE (owner's decision, 2026-09-27). A Stadtwerke is municipally OWNED
  // but its core business is operating real infrastructure — grids, heat, water — so it belongs with Fluvius
  // System Operator and De Vlaamse Waterweg rather than with a town hall. CORE BUSINESS, NOT OWNERSHIP, is
  // the better predictor, and the costs are asymmetric: a false positive here is one irrelevant lead, while a
  // false negative silently holds back a real substation job. The same reasoning keeps Ministério da Defesa
  // Nacional - Marinha and Riigilaevastik (the Estonian State Fleet) industrial: both are public bodies whose
  // work is ship repair, which is RFBT's own market. Public does not mean irrelevant.
  // English-language local government.
  { re: /\b(city|county|borough|district|parish|town) council\b|\bcouncil of\b/i, why: 'UK and Irish local authorities' },
];

export type MunicipalVerdict = { municipal: true; term: string; buyer: string } | { municipal: false };

/** Does this single buyer name read as a municipality or local-government body? */
export function municipalBuyer(buyer: string | null | undefined): { term: string } | null {
  const n = String(buyer ?? '');
  if (!n.trim()) return null;
  for (const { re } of MUNICIPAL) {
    const m = n.match(re);
    if (m) return { term: m[0] };
  }
  return null;
}

/**
 * The lead-level verdict: municipal only when EVERY named buyer is. A contract shared with an industrial
 * buyer is industrial work, and an award with no buyer on file is never ranked down — absence of a name is
 * not evidence of a town hall, and 8 of the 181 TED articles carry no authority line at all.
 */
export function municipalAward(buyers: string[] | null | undefined): MunicipalVerdict {
  const names = (buyers ?? []).map((b) => String(b ?? '').trim()).filter(Boolean);
  if (!names.length) return { municipal: false };
  const hits = names.map((n) => ({ n, hit: municipalBuyer(n) }));
  if (hits.some((h) => !h.hit)) return { municipal: false };
  const first = hits[0];
  return { municipal: true, term: first.hit!.term, buyer: first.n };
}

/** One line for the row, so a lead that sorted lower says why rather than just being lower. */
export function municipalWhy(v: MunicipalVerdict): string | null {
  return v.municipal ? `sorted lower — public-sector buyer (${v.buyer})` : null;
}
