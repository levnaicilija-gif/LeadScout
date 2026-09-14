import { TRADE_CPV } from '@/lib/tender/cpv';
import { sentences, isProse } from '@/lib/radar-filter';

/**
 * Item 18 part 2 — which industries a lead or a Hiring now company belongs to, from what is already stored.
 *
 * No model call, and nothing counts that is not written down:
 *   - a contract award notice: its CPV codes, and only codes on item 12's confirmed list (src/lib/tender/cpv.ts),
 *     matched by the same rule item 12 uses (a code and its descendants down to five significant digits, the code
 *     alone below that). A trade code that names no industry — scaffolding, structural steelworks, welding —
 *     gives none: a scaffolding award is scaffolding for a school as often as for a refinery.
 *   - a news story: words in its title, its project name and its prose. Prose only: stored pages open with the
 *     site's navigation, and offshore-energy.biz's reads "offshoreWIND.biz … Hydrogen …" on every story.
 *   - a Hiring now company: the titles of its adverts, and only the quoted words in its employer-type evidence
 *     (the rest of that evidence is a model's summary). companies.sector is not used: it is partly model-assigned.
 *
 * A lead may belong to several industries. One that matches none is Other / Uncategorized — a correct answer,
 * not a gap to be closed by looser words. Every tag keeps the words that made it, so any tag can be checked.
 */

export const INDUSTRIES = [
  { id: 'renewable_general', n: 1, label: 'Renewable Energy (General Transition Projects)' },
  { id: 'offshore_wind', n: 2, label: 'Offshore Wind' },
  { id: 'onshore_wind', n: 3, label: 'Onshore Wind' },
  { id: 'solar', n: 4, label: 'Solar (Utility-Scale)' },
  { id: 'hydrogen_ptx', n: 5, label: 'Hydrogen / PtX / Green Hydrogen / Ammonia / e-Fuels' },
  { id: 'grid', n: 6, label: 'Grid / Transmission / Interconnectors' },
  { id: 'oil_gas', n: 7, label: 'Oil & Gas (Transition, Maintenance, Brownfield, Decommissioning)' },
  { id: 'petrochemical', n: 8, label: 'Petrochemical' },
  { id: 'marine_offshore_construction', n: 9, label: 'Marine & Offshore Construction' },
  { id: 'fabrication_heavy_industry', n: 10, label: 'Fabrication Yards & Heavy Industry' },
  { id: 'coatings_corrosion', n: 11, label: 'Industrial Coatings & Corrosion Protection' },
  { id: 'ccs', n: 12, label: 'Carbon Capture & Storage' },
  { id: 'mining_metals', n: 13, label: 'Mining & Metals' },
  { id: 'data_centers', n: 14, label: 'Data Centers' },
  { id: 'pharma_life_sciences', n: 15, label: 'Pharma & Life Sciences' },
  { id: 'infrastructure_energy_services', n: 16, label: 'Infrastructure & Energy Services' },
  { id: 'other', n: 17, label: 'Other / Uncategorized' },
] as const;
export type IndustryId = (typeof INDUSTRIES)[number]['id'];
export const INDUSTRY_LABEL = Object.fromEntries(INDUSTRIES.map((i) => [i.id, i.label])) as Record<IndustryId, string>;

/**
 * What a recruiter follows. Offshore and Onshore Wind stay separate tags on the data, but nobody should have to
 * tick two near-identical boxes, so following Wind follows both. No other pair is grouped: Oil & Gas and
 * Petrochemical hire from different sites and value chains; Marine & Offshore Construction is vessels and quays,
 * Fabrication Yards is fabrication halls and dry docks; Hydrogen/PtX and CCS are separate project types.
 */
export const FOLLOW_OPTIONS: { id: string; label: string; industries: IndustryId[] }[] = [
  { id: 'wind', label: 'Wind (offshore and onshore)', industries: ['offshore_wind', 'onshore_wind'] },
  ...INDUSTRIES.filter((i) => i.id !== 'offshore_wind' && i.id !== 'onshore_wind').map((i) => ({ id: i.id, label: i.label, industries: [i.id] as IndustryId[] })),
];

export type IndustryEvidence = { industry: IndustryId; via: 'cpv' | 'words'; term: string; where: string };
export type Classification = { industries: IndustryId[]; evidence: IndustryEvidence[] };

/* ---------------------------------------------------------------- award notices */

/**
 * Item 12's confirmed codes that name an industry. A code not in this table gives none — including the trade
 * codes for scaffolding (45262100), steelworks (45223100, 45223210, 45262420) and welding (45262680), and the
 * turbine codes (45315200, 51133000), which cover gas and hydro turbines as much as wind.
 */
const CPV_INDUSTRY: Record<string, IndustryId> = {
  // Wind: which kind the code does not say; the notice's own words decide (see windKind), else Renewable general.
  '45251160': 'renewable_general', '31121340': 'renewable_general',
  '45232200': 'grid', '45231400': 'grid', '45317200': 'grid', '45317300': 'grid',
  '45255000': 'oil_gas', '45231200': 'oil_gas', '76200000': 'oil_gas', '76310000': 'oil_gas', '76320000': 'oil_gas',
  '76500000': 'oil_gas', '76600000': 'oil_gas', '43131000': 'oil_gas', '34514000': 'oil_gas',
  '45262421': 'marine_offshore_construction', '50246400': 'marine_offshore_construction',
  '45241000': 'marine_offshore_construction', '45244000': 'marine_offshore_construction',
  '45262424': 'fabrication_heavy_industry',
  '34511100': 'fabrication_heavy_industry', '34512000': 'fabrication_heavy_industry', '34513000': 'fabrication_heavy_industry',
  '50241000': 'fabrication_heavy_industry', '50242000': 'fabrication_heavy_industry', '50244000': 'fabrication_heavy_industry',
  '50245000': 'fabrication_heavy_industry', '50246100': 'fabrication_heavy_industry', '45248200': 'fabrication_heavy_industry',
  '45442120': 'coatings_corrosion', '45442121': 'coatings_corrosion', '45442200': 'coatings_corrosion', '90912000': 'coatings_corrosion',
  '45232140': 'infrastructure_energy_services', '45251000': 'infrastructure_energy_services',
};
const WIND_CODES = new Set(['45251160', '31121340']);

/** The same rule as item 12's covers(): descendants down to five significant digits, the code alone below. */
function covers(entry: string, code: string) {
  const stem = entry.replace(/0+$/, '');
  return stem.length > 5 ? code === entry : code.startsWith(stem.padEnd(2, '0'));
}

/** The CPV codes an award notice's stored text lists ("Main CPV code:" and "All CPV codes:" lines, item 12). */
export function cpvCodesIn(noticeText: string): string[] {
  const lines = String(noticeText ?? '').split('\n').filter((l) => /^(Main CPV code|All CPV codes):/.test(l.trim()));
  return [...new Set(lines.flatMap((l) => l.match(/\b\d{8}\b/g) ?? []))];
}

export function classifyAward(noticeText: string): Classification {
  const evidence: IndustryEvidence[] = [];
  for (const code of cpvCodesIn(noticeText)) {
    // The most specific confirmed entry covering this code decides it: 45251160 (wind-power installation) also
    // sits under 45251000 (power plants), and it is a wind award, not a power-plant one.
    const entry = TRADE_CPV.filter((e) => covers(e.code, code)).sort((a, b) => b.code.replace(/0+$/, '').length - a.code.replace(/0+$/, '').length)[0];
    if (!entry) continue;
    let industry = CPV_INDUSTRY[entry.code];
    if (!industry) continue;
    if (WIND_CODES.has(entry.code)) industry = windKind(noticeText) ?? 'renewable_general';
    evidence.push({ industry, via: 'cpv', term: `${code} ${entry.label}`, where: 'award notice CPV codes' });
  }
  return finish(evidence);
}

/** Offshore or onshore, only where the text says which. */
function windKind(text: string): IndustryId | null {
  if (/\boffshore\b|\bhavvind|\bOffshore-Wind|\bop zee\b/i.test(text)) return 'offshore_wind';
  if (/\bonshore\b|\bland-?based\b|\bpå land\b|\ban Land\b/i.test(text)) return 'onshore_wind';
  return null;
}

/* ---------------------------------------------------------------- words */

/** Word rules, each specific enough that a match says the industry on its own. Case-insensitive, whole words. */
const WORDS: { industry: IndustryId; re: RegExp }[] = [
  { industry: 'offshore_wind', re: /\boffshore[- ]wind\w*|\bfloating wind\b|\bhavvind\w*|\boffshore[- ]?windpark\w*|\bwindpark op zee\b|\bOffshore-Windpark\w*|\bwind farms? at sea\b/i },
  { industry: 'onshore_wind', re: /\bonshore[- ]wind\w*|\bland-?based wind\b|\bvindpark(er)? på land\b|\bWindpark an Land\b|\bonshore wind farm\b/i },
  { industry: 'solar', re: /\bsolar (park|farm|plant|power plant|pv plant|project)s?\b|\bphotovoltaic (park|plant|power)\b|\bsolpark\w*|\bsolcellepark\w*|\bzonnepark\w*|\bSolarpark\w*|\b\d+\s?MWp\b/i },
  { industry: 'hydrogen_ptx', re: /\bhydrogen\b|\belectroly[sz]er\w*|\bpower[- ]to[- ]x\b|\bPtX\b|\be-?fuels?\b|\bgreen ammonia\b|\be-?ammonia\b|\be-?methanol\b|\bsyngas\b|\bWasserstoff\w*|\bwaterstof\w*|\bhydrogène\b|\bhydrogeno\b/i },
  { industry: 'grid', re: /\binterconnectors?\b|\btransmission (lines?|systems?|grid|network|operator)\b|\bsubstations?\b|\bconverter stations?\b|\bHVDC\b|\bhigh[- ]voltage\b|\bpower lines?\b|\bexport cables?\b|\bgrid connection\b|\bgrid (reinforcement|upgrade|expansion)\b|\btransformer stations?\b|\bUmspannwerk\w*|\btransformatorstasjon\w*/i },
  { industry: 'oil_gas', re: /\boil (and|&) gas\b|\boil ?fields?\b|\bgas fields?\b|\bLNG\b|\bFPSO\b|\bsubsea (tie-?backs?|developments?|fields?)\b|\btie-?in\b|\bdrilling (rig|contract|campaign)s?\b|\brig contract\b|\bproduction platforms?\b|\boffshore platforms?\b|\bbrownfield\b|\bplug and abandonment\b|\bOCTG\b|\btubulars\b|\bgas (pipeline|processing|compression|cap)\b|\bpipeline integrity\b|\bupstream\b|\bNorwegian continental shelf\b|\bMMO\b/i },
  { industry: 'petrochemical', re: /\bpetrochemical\w*|\brefiner(y|ies)\b|\bsteam cracker\b|\bpolyethylene\b|\bpolypropylene\b|\bchemical (plant|complex|park)s?\b/i },
  { industry: 'marine_offshore_construction', re: /\bmarine construction\b|\boffshore construction\b|\bjack-?up (vessel|barge|rig)s?\b|\bheavy[- ]lift vessels?\b|\bcable[- ]lay\w*|\bdredg\w*|\bquay( wall)?s?\b|\bbreakwaters?\b|\bharbou?r (construction|expansion|works)\b|\bport (expansion|construction|development)\b|\bsubsea installation\b|\bmonopile installation\b|\boffshore (base|logistics)\b/i },
  { industry: 'fabrication_heavy_industry', re: /\bshipyards?\b|\bshipbuilding\b|\bnew ?build(ing)? (vessels?|ships?)\b|\b(new|ocean|cruise|naval) ships?\b|\bdry[- ]?docks?\b|\bfabrication (yard|hall|contract)s?\b|\bmodule fabrication\b|\btopsides?\b|\bjackets? (fabrication|structures?)\b|\bheavy industry\b|\bskibsbygg\w*|\bskibsmontør\w*|\bverft\w*|\bværft\w*|\bWerft\w*/i },
  { industry: 'coatings_corrosion', re: /\bcoatings?\b|\banti-?corrosion\b|\bcorrosion protection\b|\bsurface treatment\b|\bblast(ing)? and paint\w*|\bFROSIO\b|\boverflatebehandl\w*|\bKorrosionsschutz\b/i },
  { industry: 'ccs', re: /\bcarbon capture\b|\bCCUS?\b|\bCO2 (storage|terminal|transport|capture|shipping|transshipment)\b|\bcarbon (storage|sequestration)\b/i },
  { industry: 'mining_metals', re: /\bmining\b|\bmines?\b(?! (the|a) )|\bcopper (mine|project|production|concentrate|smelter)s?\b|\b(gold|silver)(-(gold|silver))? (mine|project)s?\b|\biron ore\b|\bsmelters?\b|\blithium (mine|project|refinery)\b/i },
  { industry: 'data_centers', re: /\bdata[- ]?cent(er|re)s?\b|\bhyperscale\b/i },
  { industry: 'pharma_life_sciences', re: /\bpharma(ceutical)?\w*|\blife sciences?\b|\bbiotech\w*|\bvaccine (plant|facility)\b/i },
  { industry: 'infrastructure_energy_services', re: /\bhigh[- ]speed rail\b|\brailways?\b|\brail (line|project|infrastructure)s?\b|\bhighways?\b|\bmotorways?\b|\broad (improvement|construction|project)s?\b|\bbridges?\b|\btunnels?\b|\bcivil (works|engineering)\b|\bdistrict heating\b|\bpower (plant|station)s?\b|\bnuclear\b|\bwater treatment\b|\bwastewater\b|\bframework\b.{0,40}\bconstruction\b/i },
  // Not "energy transition": stories use it as background ("…as demand for copper grows with the energy transition"),
  // and it tagged a BHP copper project and Equinor's careers page as renewable energy.
  { industry: 'renewable_general', re: /\brenewables?\b|\bhydro ?power\b|\bpumped (hydro )?storage\b|\bbattery (energy )?storage\b|\benergy storage\b|\bgeothermal\b|\bbiomass\b|\bbiogas\b/i },
];
/** A wind farm or turbine that does not say offshore or onshore: Renewable general, with the words kept. */
const WIND_UNSPECIFIED = /\bwind (farm|park|turbine|power|project)s?\b|\bwindturbine\w*|\bWindkraft\w*|\bvindmølle\w*|\bvindkraft\w*|\bWind Turbines?\b/i;

/**
 * Domain names out before anything is read: a site menu is full of them ("DredgingToday.com", "offshoreWIND.biz"),
 * their ".com" and ".biz" count as the lower-case words that make a line look like prose, and "Dredging" then
 * tagged every offshore-energy.biz story as marine construction.
 */
const stripDomains = (s: string) => String(s ?? '').replace(/\b[\w-]+(\.[\w-]+)*\.(com|biz|net|org|io|info|eu|no|dk|de|nl|se|fi|uk|fr|es|it|be)\b\/?\S*/gi, ' ');

function wordsIn(text: string, where: string, out: IndustryEvidence[]) {
  const t = stripDomains(text).replace(/₂/g, '2');
  for (const w of WORDS) {
    const m = t.match(w.re);
    if (m) out.push({ industry: w.industry, via: 'words', term: m[0], where });
  }
  const wind = t.match(WIND_UNSPECIFIED);
  if (wind && !out.some((e) => e.industry === 'offshore_wind' || e.industry === 'onshore_wind')) {
    out.push({ industry: windKind(t) ?? 'renewable_general', via: 'words', term: wind[0], where });
  }
}

/**
 * A company's standard paragraph about itself. Press releases end with one ("Bechtel works in LNG, mining,
 * refineries…", "Jacobs… life sciences, data centers…"), and the first run of this classifier tagged a high-speed
 * rail story with LNG, mining and refineries, and every Jacobs story with data centers and life sciences.
 */
const BOILERPLATE = /^about\b|\bis (a|an|the) (leading|global|world|international|premier|multinational)\b|\bheadquartered in\b|\bemploys (over|more than|around|approximately)?\s?[\d,.]+\b|\b(NYSE|Nasdaq|Euronext|Oslo Børs|LSE)\b|\bforward-looking statements?\b|\bfor more information\b|\bmedia (contact|enquiries|inquiries)\b|\bwith (over|more than) [\d,.]+ (employees|people)\b/i;
/** How much of a story counts: its opening, where it says what was won. The rest drifts into background. */
const STORY_SENTENCES = 10;

/**
 * A sentence that names three or more industries is a company describing its portfolio, not a story saying what
 * was won: McDermott's releases carry "LNG, petrochemical, marine construction…" and Jacobs's "data centers, life
 * sciences…" near the top, where no "About" heading marks them. Such a sentence tags nothing.
 */
const PORTFOLIO_INDUSTRIES = 3;

const normSentence = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/**
 * Sentences a site prints on more than one of its stories: its menus, its teasers, its paragraph about itself.
 * jacobs.com prints "Intelligent, data-driven solutions that … data center …" on every story, and McDermott's
 * releases all carry "Operating in over 30 countries, McDermott's … resources include … marine construction";
 * the first run of this classifier read each as the story. Keyed by site, from the articles already stored.
 */
export function repeatedSentences(articles: { url: string; text: string | null }[], minStories = 2): Map<string, Set<string>> {
  const counts = new Map<string, Map<string, number>>();
  for (const a of articles) {
    const host = hostOf(a.url);
    if (!host) continue;
    const perSite = counts.get(host) ?? counts.set(host, new Map()).get(host)!;
    for (const s of new Set(sentences(stripDomains(a.text ?? '')).map(normSentence))) perSite.set(s, (perSite.get(s) ?? 0) + 1);
  }
  const out = new Map<string, Set<string>>();
  for (const [host, perSite] of counts) out.set(host, new Set([...perSite].filter(([, n]) => n >= minStories).map(([s]) => s)));
  return out;
}

export function classifyNews(input: { title?: string | null; projectName?: string | null; text?: string | null; url?: string | null }, siteSentences?: Map<string, Set<string>>): Classification {
  const evidence: IndustryEvidence[] = [];
  if (input.title) wordsIn(input.title, 'article title', evidence);
  if (input.projectName) wordsIn(input.projectName, 'project name', evidence);
  const chrome = siteSentences?.get(hostOf(input.url ?? '')) ?? new Set<string>();
  const story = sentences(stripDomains(input.text ?? '')).filter(isProse).filter((s) => !BOILERPLATE.test(s) && !chrome.has(normSentence(s))).slice(0, STORY_SENTENCES);
  for (const s of story) {
    const found: IndustryEvidence[] = [];
    wordsIn(s, `article prose: "${s.slice(0, 140)}${s.length > 140 ? '…' : ''}"`, found);
    if (new Set(found.map((e) => e.industry)).size >= PORTFOLIO_INDUSTRIES) continue;
    evidence.push(...found);
  }
  return finish(evidence);
}

/** The words inside quotation marks in a model-written evidence summary — the only part copied off the page. */
export function quotedIn(evidence: string | null | undefined): string[] {
  const s = String(evidence ?? '');
  return [...s.matchAll(/["“'‘]([^"”'’]{3,200})["”'’]/g)].map((m) => m[1]);
}

export function classifyCompany(input: { postingTitles: string[]; employerEvidence?: string | null }): Classification {
  const evidence: IndustryEvidence[] = [];
  for (const t of input.postingTitles) wordsIn(t, 'advert title', evidence);
  for (const q of quotedIn(input.employerEvidence)) wordsIn(q, 'quoted from the company page', evidence);
  return finish(evidence);
}

function finish(evidence: IndustryEvidence[]): Classification {
  const seen = new Map<string, IndustryEvidence>();
  for (const e of evidence) if (!seen.has(`${e.industry}|${e.term.toLowerCase()}`)) seen.set(`${e.industry}|${e.term.toLowerCase()}`, e);
  const kept = [...seen.values()];
  // Renewable general is the fallback: once a specific renewable category is named, it adds nothing.
  const specificRenewable = kept.some((e) => ['offshore_wind', 'onshore_wind', 'solar', 'hydrogen_ptx'].includes(e.industry));
  const final = specificRenewable ? kept.filter((e) => e.industry !== 'renewable_general' || e.via === 'cpv') : kept;
  const industries = INDUSTRIES.map((i) => i.id).filter((id) => final.some((e) => e.industry === id)) as IndustryId[];
  return industries.length ? { industries, evidence: final } : { industries: ['other'], evidence: [] };
}
