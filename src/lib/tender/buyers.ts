/**
 * Buyers whose work is ours whatever CPV code the notice carries.
 *
 * WHY THIS EXISTS. Item 12 keeps a notice only when its procedure's MAIN classification is on the
 * trade list (`ingest.ts` → `tradeCpvFor(a.mainCpv)`), and that rule is right about what it sees.
 * What it cannot see is a contract filed under a generic parent code. Measured over 60 days of TED,
 * our codes keep about 1% of award notices in every country — Denmark 3 of 408, the Netherlands 2 of
 * 1,435, Norway 0 of 426 — and the most-dropped main code is `45000000`, the bare "Construction
 * work" a buyer uses when a mixed contract fits no one specialism. Reading Denmark's 46 of those:
 * Ørsted Bioenergy & Thermal Power, Energinet Eltransmission three times, a 60/10 kV substation, a
 * pipeline relay. Every one dropped. The same hole in Germany drops EnBW Hohe See and EnBW Albatros,
 * two North Sea offshore wind farms.
 *
 * Widening the CPV list is not the answer: the same generic code carries Trondheim kommune's schools
 * and Gemeente Krimpenerwaard's sports hall, which is the false-positive flood CLAUDE.md already
 * records ("a school build that lists a scaffolding lot among twenty codes is a school build").
 * Neither signal is sufficient alone — the CPV says what the work is, the buyer says whose it is.
 *
 * WHY A CURATED LIST AND NOT A DERIVED STEM. `canonCompany` was tested for this and is unsafe in
 * BOTH directions: it strips the legal form, which is the only thing separating "TenneT TSO B.V."
 * from "TenneT TSO GmbH" and "Kraftwerk AG" from "Kraftwerk AS" (over-grouping, a false merge), and
 * it never groups "Energinet" with "Energinet Eltransmission A/S" because descriptive words are
 * deliberately never stripped (under-grouping). Its own docstring says it is for company identity and
 * that a wrong merge is unrecoverable. So each entry carries its OWN match string, written by hand
 * with the evidence that put it here — the same shape as `TRADE_CPV`, and for the same reason.
 *
 * DERIVED FROM FREQUENCY, NOT FROM MEMORY. Six months of TED awards under the generic codes, grouped
 * by buyer: DNK 461 awards / 214 buyers, NOR 447 / 150, NLD 932 / 385, BEL 762 / 353, SWE 1,453 /
 * 358, DEU 17,918 (4,000 read). Every `awards` figure below is that count. Energinet appears in it
 * as TWO rows — "Energinet Eltransmission A/S" 24 and "Energinet" 5 — which is exactly why the match
 * is a curated stem rather than a name.
 *
 * DELIBERATELY NOT HERE (owner's decision 2026-09-20): roads and rail. Vejdirektoratet 33,
 * Banedanmark 27, Trafikverket 311, DB InfraGO 132, Infrabel 32, ProRail 22, NMBS 14, Die Autobahn
 * GmbH, DEGES — all high-volume, none of them RFBT's trades. Including them would dilute this list
 * the way the generic CPV codes already dilute the other one. Revisit only if the trade scope ever
 * extends into civil infrastructure. Airports (Swedavia 30, Københavns Lufthavne 4) are out on the
 * same reasoning. State property and schools estates (STATSBYGG 47, Statens fastighetsverk 18,
 * Vermögen und Bau, SBH Schulbau Hamburg 57) are municipal building by another name.
 *
 * NORWAY IS ABSENT AND THAT IS THE FINDING. Its top buyers under these codes are STATSBYGG,
 * Statens vegvesen, Forsvarsbygg and Helse Sør-Øst — state property, roads, defence estates,
 * hospitals. No grid or offshore operator appears, because Norway's offshore work is bought by
 * private operators who never publish to TED at all. An allowlist does not rescue Norway.
 */
import type { TenderSector } from './cpv';

/** What kind of buyer this is — the axis that decides whether the work is ours. */
export type BuyerKind = 'grid' | 'offshore_wind' | 'port_marine' | 'energy' | 'water' | 'naval';

export type TradeBuyer = {
  /** Normalised stem, matched on word boundaries against a normalised buyer name. Never a regex. */
  match: string;
  /** Who they are, in plain words. */
  label: string;
  country: string;
  kind: BuyerKind;
  /** The evidence that put them here: what they buy, and how many awards the derivation counted. */
  why: string;
  /**
   * The term to send to TED's `buyer-name~"…"`, when the match stem above will not find them.
   *
   * TED's `~` is whole-word and folds diacritics, but NOT the way `normalizeBuyer` does, and the two
   * disagree on exactly two letters. Measured against the live API on 2026-09-21: "Stadtwerke Munchen"
   * and "muenchen" both find München, so ü folds to u AND ue; "vestforbraending" finds Vestforbrænding,
   * so æ folds to ae; but "kredsloeb" finds nothing while "kredslob" finds four, and "joenkoeping"
   * finds nothing while "jonkoping" finds ten — ø and ö fold to a bare o. Prefixes do not work at all:
   * "Kredsl" and "Vestforbr" both return zero, because this matches words rather than substrings.
   *
   * So the search term is stated per entry rather than derived, and only where it has to be. Sixteen
   * of the eighteen entries are found by their own match stem, each returning buyers that
   * `tradeBuyerFor` agrees with; `scripts/ted-buyer-terms-check.ts` re-runs that against TED whenever
   * this list changes, because a term that quietly finds nothing is a buyer silently dropped.
   */
  search?: string;
  /**
   * A stem under five characters, allowed only with a reason. Short stems are the one way this list
   * could put a town council back into the leads, so the exception is per entry and visible rather
   * than a lower threshold for everybody.
   */
  shortOk?: string;
};

/**
 * Nordic and German letters folded BEFORE accents are stripped, because NFD does not decompose them:
 * "ø", "æ" and "ß" are letters in their own right, so "Kredsløb" and "Vestforbrænding" would keep
 * characters no one can type into a match string. Folding them makes every entry below readable.
 */
const FOLD: [RegExp, string][] = [
  [/ß/g, 'ss'], [/æ/g, 'ae'], [/ø/g, 'oe'], [/å/g, 'aa'],
  [/ö/g, 'oe'], [/ä/g, 'ae'], [/ü/g, 'ue'],
];

/** One comparable spelling. Legal forms are NOT stripped — see the TenneT note above. */
export function normalizeBuyer(name: string): string {
  let s = String(name ?? '').toLowerCase();
  for (const [re, to] of FOLD) s = s.replace(re, to);
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export const TRADE_BUYERS: TradeBuyer[] = [
  // ---- Denmark
  { match: 'energinet', label: 'Energinet', country: 'DK', kind: 'grid',
    why: 'Danish TSO — electricity and gas transmission. 29 awards under the generic codes (24 as "Energinet Eltransmission A/S", 5 as "Energinet"), 0 kept by CPV today; also the buyer on three of the 46 Danish 45000000 awards read by hand.' },
  { match: 'n1 a s', label: 'N1 A/S', country: 'DK', kind: 'grid',
    why: 'Danish electricity distribution operator. 12 awards, 0 kept. Matched on the full "N1 A/S" rather than "n1", which is too short to be safe as a stem.' },
  { match: 'ctr i s', label: 'CTR I/S', country: 'DK', kind: 'energy',
    why: 'Greater Copenhagen district-heating transmission. 8 awards, 0 kept. Full form for the same reason as N1.' },
  { match: 'by havn', label: 'Udviklingsselskabet By & Havn I/S', country: 'DK', kind: 'port_marine',
    why: 'Copenhagen port and harbour development. 7 awards, 0 kept.' },
  { match: 'vestforbraending', label: 'I/S Vestforbrænding', country: 'DK', kind: 'energy',
    why: 'Waste-to-energy plant and district heating. 6 awards, 1 kept.' },
  { match: 'kredsloeb transmission', search: 'kredslob', label: 'Kredsløb Transmission A/S', country: 'DK', kind: 'energy',
    why: 'Aarhus district-heating transmission. 4 awards, 1 kept.' },

  // ---- Netherlands
  { match: 'nederlandse gasunie', label: 'N.V. Nederlandse Gasunie', country: 'NL', kind: 'grid',
    why: 'Dutch gas transmission. 10 awards, 1 kept. The name leads with its legal form ("N.V."), which is why matching is word-bounded containment rather than a prefix.' },
  { match: 'tennet', label: 'TenneT TSO', country: 'NL', kind: 'grid',
    why: 'Electricity TSO. 8 awards in NL, 0 kept. ONE entry covering both TenneT TSO B.V. (NL) and TenneT TSO GmbH (DE) — a deliberate editorial choice, since both are grid operators whose work is ours; they are separate legal entities and could be split if that ever matters.' },

  // ---- Belgium
  { match: 'fluvius', label: 'Fluvius System Operator', country: 'BE', kind: 'grid',
    why: 'Flemish electricity and gas distribution. 22 awards across its two filing names (13 "Speciale Sectoren", 9 "Klassieke Sectoren"), 0 kept.' },
  { match: 'vlaamse waterweg', label: 'De Vlaamse Waterweg nv', country: 'BE', kind: 'port_marine',
    why: 'Flemish inland waterways, locks and quay walls. 10 awards, 0 kept.' },
  { match: 'haven van antwerpen', label: 'Haven van Antwerpen-Brugge', country: 'BE', kind: 'port_marine',
    why: 'Port of Antwerp-Bruges. 9 awards, 1 kept.' },

  // ---- Sweden
  { match: 'ellevio', label: 'Ellevio AB', country: 'SE', kind: 'grid',
    why: 'Swedish electricity distribution. 16 awards, 3 kept — the highest already-kept share of any buyer here, so it is the one whose gain will be smallest.' },
  { match: 'joenkoeping energi', search: 'jonkoping', label: 'Jönköping Energi AB', country: 'SE', kind: 'energy',
    why: 'Municipal energy company — district heating and power. 14 awards, 0 kept.' },

  // ---- Germany
  { match: 'stadtwerke muenchen', label: 'Stadtwerke München GmbH', country: 'DE', kind: 'energy',
    why: 'Munich utility — power, heat, water. 32 awards, 0 kept, and the only operator in the German top 26, which is otherwise rail, motorways and state property. Named specifically: a bare "stadtwerke" stem would match several hundred municipal utilities at once.' },
  { match: 'enbw', label: 'EnBW', country: 'DE', kind: 'offshore_wind',
    shortOk: 'four characters, but a coined brand that is not a word in any of our languages and does not occur inside another buyer name in the six-month derivation',
    why: 'Buyer of the EnBW Hohe See and EnBW Albatros North Sea offshore wind farms — read by hand off a 2026-09-06 award (CPV 76520000) whose eForms authority-activity is "(none)", so it scores zero on a codes-only reading. The case that started this list.' },
  { match: 'stromnetz berlin', label: 'Stromnetz Berlin GmbH', country: 'DE', kind: 'grid',
    why: 'Berlin electricity distribution. Read off a 2026-09-10 award (CPV 45317300); activity code "(none)", legal type pub-undert-la.' },
  { match: 'marinearsenal', label: 'Marinearsenal', country: 'DE', kind: 'naval',
    why: 'German naval dockyard, including Warnowwerft — ship repair (CPV 50241000/50244000) across four awards in the 60-day buyer-mix run. Codes it as "defence", which no activity-based rule would put in our world.' },
  { match: 'n ergie', label: 'N-ERGIE Aktiengesellschaft', country: 'DE', kind: 'energy',
    why: 'Nuremberg energy utility. Read off a 2026-08-07 award (CPV 45251142, heat/power plant construction).' },
];

/**
 * The buyer, if this is one of ours. Word-bounded containment rather than a prefix, because several
 * real names lead with a legal form ("N.V. Nederlandse Gasunie", "I/S Vestforbrænding").
 *
 * Containment is why every `match` above is at least five characters or a full legal name: a short
 * stem would collide with an unrelated buyer, which is the one failure that would put a town council
 * back into the leads this list exists to sharpen.
 */
export function tradeBuyerFor(name: string | null | undefined): TradeBuyer | undefined {
  const n = normalizeBuyer(name ?? '');
  if (!n) return undefined;
  for (const b of TRADE_BUYERS) {
    const m = normalizeBuyer(b.match);
    if (n === m) return b;
    if (n.startsWith(`${m} `)) return b;
    if (n.endsWith(` ${m}`)) return b;
    if (n.includes(` ${m} `)) return b;
  }
  return undefined;
}

/**
 * Derived, measured, and deliberately NOT in force (owner's decision 2026-09-20).
 *
 * Water and wastewater utilities are the right KIND of buyer and mostly the wrong kind of work. In
 * the 60-day rule comparison they were 20 of the 42 awards the tightened rule would add — half the
 * headline gain — and Aquafin alone was 17 of them, almost every one CPV 45232411 "sewage pipeline
 * construction" won by road and civil contractors (Colas Noord four times, WILLEMEN INFRA, APK
 * Wegenbouw, BESIX Infra). That is trench work, not the offshore, marine and industrial fabrication
 * RFBT staffs, and leaving it in would inflate the gain with contracts a recruiter discards — the
 * same dilution the generic CPV codes already cause.
 *
 * Kept here rather than deleted, because the derivation behind them is real and the judgement is a
 * business one that may change: Aquafin's OTHER code, 45232420 "sewage treatment works" (FABRICOM,
 * TREVI, DCA INFRA), is plant with tanks, pipework and coatings and is far closer to our trades.
 * Re-admitting any of these means re-running the comparison, not editing this list by hand.
 *
 * tradeBuyerFor does not consult this array.
 */
export const DEFERRED_BUYERS: TradeBuyer[] = [
  { match: 'novafos', label: 'NOVAFOS A/S', country: 'DK', kind: 'water',
    why: 'Water and wastewater utility for 9 municipalities north of Copenhagen. 14 awards, 2 kept.' },
  { match: 'aquafin', label: 'Aquafin NV', country: 'BE', kind: 'water',
    why: 'Flemish wastewater transport and treatment infrastructure. 26 awards, 0 kept.' },
  { match: 'farys', label: 'Farys', country: 'BE', kind: 'water',
    why: 'Flemish drinking water and sewerage. 7 awards, 0 kept.' },
  { match: 'vlaamse maatschappij voor watervoorziening', label: 'De Watergroep', country: 'BE', kind: 'water',
    why: 'Flemish drinking-water supply, trading as De Watergroep. 6 awards under the generic codes, 0 kept by CPV today.' },
];

/** Item 12's own sectors, for a lead made from a buyer match rather than a CPV match. */
export const KIND_SECTOR: Record<BuyerKind, TenderSector> = {
  grid: 'grid',
  offshore_wind: 'offshore_wind',
  port_marine: 'marine_yard',
  energy: 'heat_power',
  water: 'heat_power',
  naval: 'marine_yard',
};
