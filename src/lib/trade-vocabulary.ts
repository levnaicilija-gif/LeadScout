/**
 * The trades RFBT places, their categories, and the words a real advert uses for each.
 *
 * WHY THIS IS ITS OWN FILE. `trades.ts` holds the MATCHER and the scope rules; this holds the
 * VOCABULARY. They change for different reasons — a new trade is a commercial decision, a matching
 * bug is a code defect — and keeping them apart means a vocabulary edit cannot break the matcher.
 *
 * FOUR CATEGORIES, NOT ONE LIST (owner's decision, 2026-09-27). The original ten trades were all
 * blue-collar, and `hasRfbtTrades` — which is a BINARY 0.4 of the whole fit score — asked "does this
 * scope employ RFBT trades at all". A project manager is on essentially every industrial project, so
 * folding white-collar roles into that question would stop it discriminating: every lead would score
 * full marks for trades. Drilling and marine crew are a different problem again — they are hired by
 * vessel or rig operation rather than by project scope, which is the only thing SCOPE_RULES can read.
 * So the category is what `hasRfbtTrades` counts, and only `blue_collar` counts.
 *
 * EVERY ORIGINAL TRADE IS blue_collar ON PURPOSE, and `trades-check` asserts it: that is the property
 * which makes this change unable to move any existing lead's fit score. The 238 stored leads hold only
 * the original vocabulary, so `hasRfbtTrades` answers identically for every one of them before and
 * after. Re-scoring is a separate decision, deliberately not taken here.
 *
 * MATCH MODES EXIST BECAUSE ANCHORING IS NOT ALWAYS ENOUGH. Measured against the real corpus on
 * 2026-09-27 (110 postings, 400 articles) before any of this was written:
 *
 *   - `mechanic` matched 19 articles, every one of them "MECHANICal solutions", "MECHANICal machining".
 *   - `rigger` matched 4, every one of them "tRIGGERed steep prices".
 *   - `ab` matched 376 of 400 articles — "west-brABant", "vacABture", "kandi seven AB/crane".
 *   - `solar` matched 94, all prose about solar generation, none of them a vacancy.
 *
 * `\b` anchoring fixes the first two outright ("mechanical" has a word character after "mechanic", so
 * the boundary fails). It does NOT fix the other two, and that distinction is the whole reason modes
 * exist. `AB` is the Swedish Aktiebolag suffix, so `\bab\b` still matches half the company names in
 * Scandinavia — it is therefore `exact`, matching only a field that IS "ab" and never a word inside
 * prose. And `solar` is not substring-fragile at all, it is PROSE-fragile: the word legitimately
 * appears in every article about solar generation, so no anchoring can save it and the canonical name
 * is `solar technician` instead, with the role words as its aliases. That is a deliberate departure
 * from the term as it was handed over, and it is recorded here rather than made quietly.
 */

/** What `hasRfbtTrades` counts (blue_collar) and what it must not (everything else). */
export type TradeCategory = 'blue_collar' | 'drilling_crew' | 'marine_crew' | 'white_collar';

/**
 * `word`  — anchored on word boundaries, so "mechanic" cannot match "mechanical".
 * `exact` — the whole field must BE this term. For a token so short that any prose contains it.
 */
export type MatchMode = 'word' | 'exact';

/**
 * Words that turn a trade's PLURAL into a field of study, so the term must not match after them.
 *
 * `mechanic` is the case that earned this, and the first attempt at it was WRONG in an instructive way:
 * suppressing the trailing plural outright ("mechanics" never matches) stopped "quantum mechanics" and also
 * broke this file's own existing arm, `"Industrial Mechanics, day shift" IS mechanic` — a real plural JOB
 * TITLE. The instruction was to stop matching the field of study, not to stop matching plural titles, and a
 * rule that cannot tell those apart is not the fix. The discriminator is the QUALIFIER in front of it.
 *
 * DELIBERATELY SHORT, AND IT UNDER-MATCHES. Only the physics and engineering fields are listed; anything
 * vaguer ("structural mechanics") is left out, because every word added here can only remove a real trade
 * from a real advert, and `hasRfbtTrades` is a binary 0.4 of the fit score.
 */
export const FIELD_OF_STUDY = ['quantum', 'rock', 'soil', 'fluid', 'applied', 'classical', 'statistical', 'continuum', 'fracture'];

export type Alias = { term: string; mode?: MatchMode; why?: string };

export type TradeDef = {
  /** The canonical name. Stored in job_posts.trades and leads.trades_inferred, and shown on screen. */
  trade: string;
  category: TradeCategory;
  /**
   * Qualifiers that must NOT precede this trade's name — see `FIELD_OF_STUDY`. Used by `mechanic` alone, so
   * that "quantum mechanics" is not a vacancy while "Industrial Mechanics" still is.
   */
  notAfter?: string[];
  /** Other real titles for the SAME trade. The canonical name is always matched too, as `word`. */
  aliases?: Alias[];
  /** Why this trade is on the list at all, or what evidence put it here. */
  why?: string;
};

/**
 * ORDER DOES NOT DECIDE ANYTHING — the matcher resolves overlaps by SPAN CONTAINMENT, so
 * "orbital welder" suppresses the "welder" inside it wherever it matches. The original list came
 * first only so a diff against it stays readable.
 */
export const TRADES = [
  // ---------------------------------------------------------------- the original ten, unchanged
  { trade: 'welder', category: 'blue_collar', why: 'the original list' },
  // THE ACTIVITY IS A NAME FOR THE TRADE ON A STATED FIELD (owner's decision, 2026-09-27). A real candidate
  // on file states "Coating Inspector / QC Project Coordinator (painting & blasting background)", and before
  // these two aliases the matcher answered `["coating inspector"]` alone: `painter` is not a substring of
  // "painting" and `blaster` is not one of "blasting", so the two trades that person actually works in were
  // invisible on their own record.
  //
  // IT CHANGES NOTHING FOR SCOPE TEXT, which is why this is narrow rather than a new rule. SCOPE_RULES has
  // always mapped /coating|painting|blasting|surface treatment/ to painter and blaster for a project
  // description, so a lead or an article was never affected by this gap. What had no route at all was a
  // STATED FIELD — a candidate's own `trade`, or an advert's title through jobTrades' fallback — which goes
  // through the trade NAMES and not the scope rules, deliberately (an advert states its own trade; a project
  // implies several).
  //
  // KNOWN AND DELIBERATE LIMIT: anchoring means "sandblasting" and "sandblaster" still match nothing, since
  // the preceding "d" is a word character and there is no boundary. Measured before leaving it: sandblast*
  // appears 0 times across every advert and every candidate trade on file, so the gap is latent rather than
  // live, and the honest fix when it appears is its own alias rather than dropping the anchor here — the one
  // thing 2026-09-27 proved repeatedly is that an unanchored trade term costs more than a missing one.
  { trade: 'painter', category: 'blue_collar', aliases: [{ term: 'painting', why: 'a real candidate states a "painting & blasting background"' }], why: 'the original list' },
  { trade: 'blaster', category: 'blue_collar', aliases: [{ term: 'blasting', why: 'the same record; note that anchoring leaves "sandblasting" unmatched on purpose' }], why: 'the original list' },
  { trade: 'pipefitter', category: 'blue_collar', why: 'the original list' },
  {
    trade: 'fitter', category: 'blue_collar',
    // BOILERMAKER IS A SYNONYM, NOT A TRADE OF ITS OWN (owner's decision, 2026-09-27). It arrived in
    // the handover under both headings, which it cannot be; the owner resolved it to fitter.
    aliases: [
      { term: 'boilermaker', why: "the owner's resolution: a synonym of fitter, not a separate trade" },
      { term: 'plater', why: 'a real candidate states "plate worker / plate fitter"' },
      { term: 'plater-welder', why: 'matched with a hyphen or a space' },
      { term: 'plate worker', why: "the exact words on a candidate's own record" },
    ],
    why: 'the original list',
  },
  { trade: 'ndt', category: 'blue_collar', why: 'the original list' },
  { trade: 'rope access', category: 'blue_collar', why: 'the original list' },
  {
    trade: 'wind technician', category: 'blue_collar',
    aliases: [
      { term: 'wtg technician', why: 'the industry abbreviation for a wind turbine generator' },
      // FLAGGED RATHER THAN SILENT: "field technician" is generic and says nothing about wind. It is
      // here because the owner specified it, and it matched nothing in the real corpus, so it costs
      // nothing today; if it ever starts tagging non-wind work this alias is the first thing to remove.
      { term: 'field technician', why: "owner-specified; generic, and matched nothing in the corpus" },
    ],
    why: 'the original list',
  },
  { trade: 'electrician', category: 'blue_collar', why: 'the original list' },
  { trade: 'scaffolder', category: 'blue_collar', why: 'the original list' },

  // ---------------------------------------------------------------- new blue-collar trades
  {
    // A DISTINCT TRADE, NOT A WELDER SPECIALISATION (owner's decision, 2026-09-27). It contains the
    // word "welder", so span containment is what stops one advert being tagged as both.
    trade: 'orbital welder', category: 'blue_collar',
    why: "owner's decision: distinct from welder, and the span rule keeps them apart",
  },
  {
    trade: 'rigger', category: 'blue_collar',
    aliases: [
      { term: 'rigger/slinger' },
      { term: 'banksman', why: 'the UK title for the man directing the lift' },
      // REMOVED 2026-10-02: `dogger` is the real Australian title and was measured matching DOGGER BANK in
      // 11 articles — the North Sea wind field, in a corpus that is largely about offshore wind. Anchoring
      // cannot help, because "Dogger" IS the whole word; nor can span containment, because nothing longer
      // overlaps it. An alias that fires on a place name in the one corpus we read is worse than a missing
      // alias: it puts a trade on articles about a wind farm and feeds the binary 0.4 trades weight.
      // Australian adverts are not a population here, so nothing real is lost.
    ],
    why: 'anchored: "triggered" must not match, which it did 4 times in the real corpus',
  },
  {
    trade: 'crane operator', category: 'blue_collar',
    aliases: [{ term: 'mobile crane operator' }, { term: 'slewing crane operator' }],
  },
  {
    trade: 'hse officer', category: 'blue_collar',
    aliases: [{ term: 'hse advisor' }, { term: 'safety officer' }, { term: 'qhse coordinator' }],
  },
  {
    // Already described in the certificate library's own words — trade-cards.ts calls AMPP and every
    // FROSIO level a "Coating inspector" in coversText — while having no trade token to map to. A real
    // candidate on file states their trade as "coating inspector / qc project coordinator".
    trade: 'coating inspector', category: 'blue_collar',
    aliases: [
      { term: 'nace inspector', why: 'NACE merged with SSPC into AMPP; recruiters still write NACE' },
      { term: 'frosio inspector' },
    ],
    why: 'evidenced on a real candidate, and already the certificate library\'s own wording',
  },
  { trade: 'instrument technician', category: 'blue_collar', aliases: [{ term: 'e&i technician' }] },
  { trade: 'qa/qc inspector', category: 'blue_collar', aliases: [{ term: 'qaqc inspector' }] },
  {
    // `notAfter` since 2026-10-02: anchoring stopped "mechanical" (19 matches) but NOT the plural the default
    // `s?` allows, so "quantum mechanics" and "rock mechanics" still tagged a mechanic. The plural itself is
    // kept, because "Industrial Mechanics, day shift" is a real advert title this file already asserts.
    trade: 'mechanic', category: 'blue_collar', notAfter: FIELD_OF_STUDY,
    why: 'anchored, and the plural refused after a field-of-study qualifier: "mechanical" matched 19 times and "quantum mechanics" is not a vacancy',
  },
  {
    trade: 'substation technician', category: 'blue_collar',
    aliases: [{ term: 'hv technician' }, { term: 'relay technician' }],
  },
  {
    trade: 'lineworker', category: 'blue_collar',
    aliases: [{ term: 'linesman' }, { term: 'journeyman lineworker' }, { term: 'overhead lineworker' }],
  },
  { trade: 'millwright', category: 'blue_collar' },
  { trade: 'machinist', category: 'blue_collar' },
  {
    // RENAMED FROM THE HANDOVER'S "solar", and the reason is measured rather than stylistic: the bare
    // word matched 94 articles about solar generation, none of them a vacancy, and anchoring cannot
    // help because the word is genuinely in that prose. The role words are the trade.
    trade: 'solar technician', category: 'blue_collar',
    aliases: [
      { term: 'solar installer' },
      { term: 'solar pv technician' },
      { term: 'pv technician' },
      { term: 'bess technician', why: 'battery energy storage, hired alongside solar' },
    ],
    why: 'renamed from "solar": the bare word is prose, not a trade — 94 false matches measured',
  },

  // ---------------------------------------------------------------- drilling crew (own career path)
  { trade: 'roustabout', category: 'drilling_crew' },
  { trade: 'roughneck', category: 'drilling_crew' },
  { trade: 'derrickhand', category: 'drilling_crew', aliases: [{ term: 'derrickman' }] },
  {
    trade: 'driller', category: 'drilling_crew',
    // The corpus hits for this word were all COMPANIES and RIGS — "the offshore driller's backlog",
    // "deep value driller drillship" — never a vacancy. Anchoring does not separate those, so this
    // trade will mostly arrive through SCOPE_RULES' drill-crew phrases rather than through the word.
    why: 'the word alone names rig operators in prose as often as people; see the drill-crew scope rule',
  },
  { trade: 'toolpusher', category: 'drilling_crew' },

  // ---------------------------------------------------------------- marine crew (own career path)
  {
    trade: 'able seaman', category: 'marine_crew',
    aliases: [
      // EXACT ONLY (owner's decision, 2026-09-27). `\bab\b` still matches the Swedish Aktiebolag
      // suffix — "Kandi Seven AB" — so this matches a field that IS "ab" and never a word in prose.
      { term: 'ab', mode: 'exact', why: 'exact-only: \\bab\\b matches the Swedish AB company suffix' },
      { term: 'able-bodied seaman', why: 'matched with a hyphen or a space' },
    ],
  },
  { trade: 'bosun', category: 'marine_crew', aliases: [{ term: 'boatswain' }] },
  {
    trade: 'dp operator', category: 'marine_crew',
    aliases: [{ term: 'dynamic positioning operator' }, { term: 'dpo', mode: 'exact' }],
  },
  { trade: 'rov pilot technician', category: 'marine_crew', aliases: [{ term: 'rov pilot' }] },
  { trade: 'commercial diver', category: 'marine_crew', aliases: [{ term: 'saturation diver' }] },

  // ---------------------------------------------------------------- white collar
  // NONE OF THESE COUNT TOWARDS THE FIT SCORE, by category. They exist so a lead or an advert for a
  // project manager can be filtered, shortlisted and shown — not so that every industrial project
  // reaches full marks on the trades weight, which is what folding them into blue_collar would do.
  { trade: 'project manager', category: 'white_collar' },
  { trade: 'site manager', category: 'white_collar', aliases: [{ term: 'site supervisor' }] },
  { trade: 'corrosion engineer', category: 'white_collar' },
  { trade: 'welding engineer', category: 'white_collar', why: '"welder" does not match "welding", so this was previously invisible' },
  { trade: 'qa/qc engineer', category: 'white_collar', aliases: [{ term: 'qaqc engineer' }] },
  { trade: 'reliability engineer', category: 'white_collar' },

  // PHARMA & LIFE SCIENCES IS DELIBERATELY ABSENT (owner's decision, 2026-09-27). Its trade set —
  // cleanroom operator, validation technician, CQV engineer, process technician — has near-zero
  // overlap with anything above, no entry in CERT_TABLE, no CPV code and no candidate on file. Pharma
  // stays tracked for lead and hiring VISIBILITY without trade matching, so this list gains no
  // vocabulary that would match nothing while widening the fit gate. If a real Pharma lead arrives,
  // it is its own category and its own decision.
] as const satisfies readonly TradeDef[];

/**
 * The canonical names as an exact literal union, NOT `string`. `cpv.ts` maps 42 CPV codes to trades
 * and `certs/tables.ts` maps every certificate to them; both rely on this union to make a typo a
 * compile error rather than a trade that silently matches nothing. `as const satisfies` keeps that
 * while still checking every entry against TradeDef.
 */
export type Trade = (typeof TRADES)[number]["trade"];

/** Every canonical trade name, in definition order. */
export const TRADE_NAMES = TRADES.map((t) => t.trade);

/** The trades that count towards the fit score's trades weight. */
export const BLUE_COLLAR = TRADES.filter((t) => t.category === 'blue_collar').map((t) => t.trade);

export const categoryOf = (trade: string): TradeCategory | null =>
  TRADES.find((t) => t.trade === trade)?.category ?? null;
