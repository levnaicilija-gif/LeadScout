/**
 * Trade inference from a scope of work, and the matcher that decides what a trade name matches.
 *
 * The last run scored Vallourec (OCTG supply to Aramco) and ROSEN (pipeline integrity) at 20
 * with an empty trades list, because the model only tagged trades when an article said
 * "welder". Supply-and-service scopes are exactly where RFBT's people work: line pipe and OCTG
 * mean welding, coating and NDT; pipeline integrity means NDT technicians; cable and
 * fabrication scopes mean fitters and blasters. This maps scope language to trades so the
 * inference does not depend on the article using the word.
 *
 * ---------------------------------------------------------------------------------------------
 * THE MATCHER IS ANCHORED, AND IT DID NOT USE TO BE (2026-09-27). Both trade-name matchers were
 * plain substring tests — `t.toLowerCase().includes(r)` here and `text.includes(t)` in
 * `job-shortlist.ts` — while SCOPE_RULES has always been `\b`-anchored. That asymmetry was harmless
 * only because the ten original trade names happen to be long and distinctive. It stopped being
 * harmless the moment the vocabulary grew: measured over the real corpus before any of this was
 * written, `mechanic` matched "mechanical" 19 times, `rigger` matched "triggered" 4 times, and `ab`
 * matched 376 of 400 articles. Since `hasRfbtTrades` is a BINARY 0.4 of the fit score, that last one
 * alone would have handed almost every article full marks for trades.
 *
 * So there is now ONE matcher, `tradesInText`, and both call sites use it. Three properties earn it:
 *
 *   1. WORD BOUNDARIES. "mechanical" no longer contains a mechanic, "triggered" no longer contains a
 *      rigger. A trailing plural is still allowed (`welders` is welders), because the stored
 *      vocabulary is singular and a plural must not silently stop counting.
 *   2. SEPARATORS ARE FLEXIBLE. "plater-welder", "plater welder", "qa/qc" and "qa qc" are one term
 *      each, because a recruiter and a job board will not agree on punctuation.
 *   3. SPAN CONTAINMENT DECIDES OVERLAPS, so ORDER IN THE LIST DECIDES NOTHING. "orbital welder"
 *      suppresses the "welder" inside it. This also settles an inconsistency that was already here:
 *      `inferTrades` used `.find()`, so "pipefitter" resolved to pipefitter alone, while
 *      `job-shortlist.ts` used `.filter()` and got BOTH pipefitter and fitter from the same word.
 *      The two matchers disagreed about the same input; now the more specific wins in both.
 *
 * `exact` aliases are deliberately NOT applied to prose — see `ab` in trade-vocabulary.ts. They are
 * asked only of a single stated field, which is what `tradeOfField` is for.
 */
import { TRADES, TRADE_NAMES, BLUE_COLLAR, categoryOf, type Trade, type Alias } from './trade-vocabulary';

export { TRADES, BLUE_COLLAR, categoryOf } from './trade-vocabulary';
export type { Trade, TradeCategory } from './trade-vocabulary';

/**
 * Kept under its original name because six call sites and two other modules import it. It is now
 * EVERY canonical trade, across all four categories — which is right for "is this a trade we name",
 * the question `job-shortlist` and `trade-cards` ask of it. It is NOT the right list for the fit
 * score, and `hasRfbtTrades` no longer uses it: see BLUE_COLLAR.
 */
export const RFBT_TRADE_LIST = TRADE_NAMES;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A term becomes a word-anchored pattern whose separators are interchangeable. Built once per term at
 * module load, never inside a loop over rows.
 */
function wordPattern(term: string): RegExp {
  const parts = term.split(/[\s\-/]+/).filter(Boolean).map(escape);
  // A trailing plural is allowed so a stored "welders" still counts; see property 1 above.
  return new RegExp(`\\b${parts.join('[\\s\\-/]+')}s?\\b`, 'gi');
}

type Term = { trade: Trade; term: string; re: RegExp };

/** Every word-matchable term: each canonical name, plus each alias that is not `exact`. */
const WORD_TERMS: Term[] = TRADES.flatMap((d) => [
  { trade: d.trade, term: d.trade, re: wordPattern(d.trade) },
  ...((d as { aliases?: readonly Alias[] }).aliases ?? [])
    .filter((a) => (a.mode ?? 'word') === 'word')
    .map((a) => ({ trade: d.trade, term: a.term, re: wordPattern(a.term) })),
]);

/** Terms that must BE the whole field. Never asked of prose. */
const EXACT_TERMS: { trade: Trade; term: string }[] = TRADES.flatMap((d) =>
  ((d as { aliases?: readonly Alias[] }).aliases ?? [])
    .filter((a) => a.mode === 'exact')
    .map((a) => ({ trade: d.trade, term: a.term })),
);

const order = new Map(TRADE_NAMES.map((t, i) => [t as string, i]));
const inOrder = (ts: Set<Trade>) => [...ts].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

/**
 * Every trade named in a piece of text, anchored, with the more specific winning any overlap.
 * Returns canonical names, in vocabulary order.
 */
export function tradesInText(text: string | null | undefined): Trade[] {
  const s = String(text ?? '').toLowerCase();
  if (!s.trim()) return [];

  const hits: { trade: Trade; start: number; end: number }[] = [];
  for (const { trade, re } of WORD_TERMS) {
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) hits.push({ trade, start: m.index, end: m.index + m[0].length });
  }

  // SPAN CONTAINMENT: a hit strictly inside a longer hit is that longer term's own word, not a trade
  // of its own — "welder" inside "orbital welder", "fitter" inside a hyphenated "plater-welder".
  const kept = new Set<Trade>();
  for (const h of hits) {
    const swallowed = hits.some((o) =>
      o !== h && o.trade !== h.trade && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start);
    if (!swallowed) kept.add(h.trade);
  }
  return inOrder(kept);
}

/**
 * The trades a single STATED field names — a candidate's own `trade`, or one string out of the model's
 * trades array. This is the only place `exact` aliases apply: "AB" is an able seaman when it is the
 * whole answer, and the Swedish Aktiebolag suffix when it is a word inside a company name.
 */
export function tradeOfField(field: string | null | undefined): Trade[] {
  const s = String(field ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return [];
  const exact = EXACT_TERMS.filter((e) => e.term === s).map((e) => e.trade);
  return inOrder(new Set([...exact, ...tradesInText(s)]));
}

/**
 * THE EXISTING THIRTEEN RULES ARE BIT-IDENTICAL, and that is deliberate rather than lazy: they are
 * what produced every `trades_inferred` array on the 238 stored leads, so changing one would make this
 * commit silently re-interpret existing data the next time anything re-crawled. The new trades arrive
 * through NEW rules appended below, which can only ever add to what a future crawl infers.
 */
const SCOPE_RULES: { match: RegExp; trades: Trade[]; why: string }[] = [
  { match: /\b(line ?pipe|octg|tubular|casing|drill pipe|pipe mill|seamless pipe|welded pipe)\b/i, trades: ['welder', 'ndt', 'blaster', 'painter'], why: 'pipe supply: welded, coated and inspected' },
  { match: /\b(pipeline|pipelay|pipe-lay|subsea pipeline|flowline|riser|spool)\b/i, trades: ['welder', 'pipefitter', 'ndt', 'blaster', 'painter'], why: 'pipeline work' },
  { match: /\b(integrity (assessment|service|management)|inspection (service|campaign|programme)|in-line inspection|nipa|corrosion (survey|assessment))\b/i, trades: ['ndt', 'rope access'], why: 'integrity/inspection scope' },
  { match: /\b(cable (lay|installation|monitoring|pull|termination)|array cable|export cable|umbilical)\b/i, trades: ['electrician', 'ndt', 'rope access'], why: 'cable scope' },
  { match: /\b(monopile|jacket|transition piece|foundation|substructure|topside|substation)\b/i, trades: ['welder', 'blaster', 'painter', 'fitter', 'ndt', 'scaffolder'], why: 'offshore structure fabrication' },
  { match: /\b(fabricat|steel structure|module (build|yard)|newbuild|hull|block assembly|shipyard|yard scope)\b/i, trades: ['welder', 'fitter', 'blaster', 'painter', 'ndt', 'scaffolder'], why: 'fabrication scope' },
  { match: /\b(coating|painting|blasting|surface treatment|galvanis|metallis)\b/i, trades: ['painter', 'blaster'], why: 'surface treatment scope' },
  { match: /\b(epc|epci|epcic|turnkey|engineering, procurement)\b/i, trades: ['welder', 'pipefitter', 'fitter', 'ndt', 'painter', 'blaster', 'scaffolder', 'electrician'], why: 'EPC scope covers the full trade mix' },
  { match: /\b(o&m|operations and maintenance|service (contract|agreement)|maintenance contract|turnaround|shutdown)\b/i, trades: ['wind technician', 'electrician', 'rope access', 'fitter'], why: 'maintenance scope' },
  { match: /\b(blade (repair|inspection|service)|rotor|nacelle|turbine (install|service|maintenance))\b/i, trades: ['wind technician', 'rope access', 'electrician'], why: 'turbine scope' },
  { match: /\b(scaffold|access (solution|package)|rope access)\b/i, trades: ['scaffolder', 'rope access'], why: 'access scope' },
  { match: /\b(lng|refinery|petrochemical|process plant|terminal|storage tank)\b/i, trades: ['welder', 'pipefitter', 'ndt', 'blaster', 'painter', 'scaffolder'], why: 'process plant scope' },
  { match: /\b(drilling (rig|programme|campaign)|jack-?up|semi-?submersible|well (intervention|services))\b/i, trades: ['welder', 'fitter', 'electrician', 'ndt'], why: 'drilling scope' },

  // ------------------------------------------------------------ added 2026-09-27, one rule per new trade group
  { match: /\b(heavy lift|lifting (operation|campaign|plan)|crane (hire|service)|rigging (scope|service)|load-?out)\b/i, trades: ['rigger', 'crane operator'], why: 'lifting and rigging scope' },
  { match: /\b(hse (support|management|advisor)|safety (management|supervision)|qhse)\b/i, trades: ['hse officer'], why: 'HSE scope' },
  { match: /\b(coating inspection|paint inspection|surface treatment inspection|coating survey)\b/i, trades: ['coating inspector', 'painter', 'blaster'], why: 'coating inspection scope' },
  { match: /\b(instrumentation|e&i|electrical and instrumentation|control (system|panel)|scada)\b/i, trades: ['instrument technician', 'electrician'], why: 'instrumentation and control scope' },
  // "quality control" alone is ordinary prose in any contract announcement, so a scope word is required.
  { match: /\b(qa\/qc|quality (assurance|control) (scope|service|plan|inspection)|third-?party inspection|witness point)\b/i, trades: ['qa/qc inspector', 'ndt'], why: 'quality inspection scope' },
  { match: /\b(switchgear|transformer|hv (cable|installation|commissioning)|protection relay)\b/i, trades: ['substation technician', 'electrician'], why: 'substation and HV scope' },
  { match: /\b(overhead line|transmission line|ohl|pylon|conductor stringing)\b/i, trades: ['lineworker', 'electrician'], why: 'overhead line scope' },
  { match: /\b(rotating equipment|pump (overhaul|service)|gearbox (overhaul|service)|compressor (overhaul|service)|shaft alignment)\b/i, trades: ['millwright', 'mechanic', 'fitter'], why: 'rotating equipment scope' },
  { match: /\b(machining|cnc|machine shop|precision engineering)\b/i, trades: ['machinist'], why: 'machining scope' },
  { match: /\b(drill (crew|floor)|drilling (crew|personnel)|rig crew)\b/i, trades: ['roustabout', 'roughneck', 'derrickhand', 'driller', 'toolpusher'], why: 'drill crew scope' },
  { match: /\b(vessel crew|marine crew|crewing|dp2|dp3|dynamic positioning)\b/i, trades: ['able seaman', 'bosun', 'dp operator'], why: 'vessel crew scope' },
  { match: /\b(rov (survey|inspection|support|operation)|diving (support|campaign|spread)|imr|saturation diving)\b/i, trades: ['rov pilot technician', 'commercial diver'], why: 'ROV and diving scope' },
  { match: /\b(solar (park|farm|pv|plant)|photovoltaic|battery (energy )?storage|bess)\b/i, trades: ['solar technician', 'electrician'], why: 'solar and storage scope' },
  { match: /\b(project management|construction management|site supervision|owner'?s engineer)\b/i, trades: ['project manager', 'site manager'], why: 'project and site management scope' },
  { match: /\b(corrosion (engineering|management)|cathodic protection)\b/i, trades: ['corrosion engineer', 'coating inspector'], why: 'corrosion engineering scope' },
  { match: /\b(welding (engineering|procedure)|wps|wpqr|weld qualification)\b/i, trades: ['welding engineer', 'welder'], why: 'welding engineering scope' },
];

/**
 * Trades implied by a scope, merged with whatever the model already inferred.
 * Returns the merged list plus the reasons, so a lead can show why it was tagged.
 */
export function inferTrades(modelTrades: string[], ...scopeText: (string | undefined | null)[]) {
  const text = scopeText.filter(Boolean).join(' \n ');
  const found = new Set<Trade>();
  const why: string[] = [];

  // Each string the model returned is a STATED field, so exact aliases apply to it — unlike the scope
  // text below, which is prose and goes only through the rules.
  for (const t of modelTrades ?? []) for (const hit of tradeOfField(t)) found.add(hit);
  for (const rule of SCOPE_RULES) {
    if (!rule.match.test(text)) continue;
    rule.trades.forEach((t) => found.add(t));
    why.push(rule.why);
  }
  return { trades: inOrder(found), why };
}

/**
 * Does this scope employ RFBT trades at all? Used by the fit score, where it is a BINARY 0.4.
 *
 * ONLY blue_collar COUNTS (owner's decision, 2026-09-27). A project manager is on essentially every
 * industrial project, so counting white-collar roles here would give every lead full marks and stop
 * the weight discriminating at all; drilling and marine crew are a separate career path that the
 * placement side does not yet price. Every one of the ten original trades is blue_collar, so this
 * answers identically to the old substring version for every trade array currently stored — which is
 * the property that stops this commit re-scoring 238 leads as a side effect. `trades-check` asserts it.
 */
export const hasRfbtTrades = (trades: string[]) =>
  (trades ?? []).some((t) => tradeOfField(t).some((n) => categoryOf(n) === 'blue_collar'));
