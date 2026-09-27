/**
 * The trade vocabulary and its matcher, held to real adverts and to the real false positives.
 *
 *   npx tsx scripts/trades-check.ts
 *
 * BOTH ARMS ON EVERY NEW TERM. A matcher is two claims, and testing one proves nothing: a pattern
 * narrowed until it catches nothing passes every "this stays out" assertion, and one widened until it
 * catches everything passes every "this is caught" assertion. So every term added on 2026-09-27 is
 * asserted to match a real title AND asserted NOT to match the string that actually broke it.
 *
 * THE FALSE POSITIVES BELOW ARE MEASURED, NOT IMAGINED. Every one was read out of the live corpus
 * (110 postings, 400 articles) before the vocabulary was written, which is why they are quoted here
 * verbatim rather than invented as plausible-looking counter-examples:
 *
 *   `mechanic` matched 19 articles, all "mechanical"       `rigger` matched 4, all "triggered"
 *   `ab` matched 376 of 400 articles                        `solar` matched 94, all prose
 *
 * AND THE NO-REGRESSION ARM, which is the assertion that makes this change safe to ship without
 * re-scoring: `hasRfbtTrades` must answer IDENTICALLY to the old substring version for every trade
 * value currently stored in the database. The 238 leads and 110 postings hold only the original ten
 * names, every one of them blue_collar, so widening the vocabulary cannot move a single fit score.
 */
import {
  tradesInText, tradeOfField, inferTrades, hasRfbtTrades, categoryOf,
  RFBT_TRADE_LIST, TRADES, BLUE_COLLAR,
} from '../src/lib/trades';

let fail = 0;
const check = (name: string, pass: boolean, detail: string) => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!pass) fail++;
};
const has = (text: string, trade: string) => tradesInText(text).includes(trade as any);

// ============================================================ 1. THE MEASURED FALSE POSITIVES
// Each string is real. Each must yield the trade it looks like and does not contain.
console.log('--- the four false positives that were measured in the live corpus ---');
for (const [text, mustNot, note] of [
  ['ped bespoke mechanical solutions', 'mechanic', 'the word is "mechanical"'],
  ['ply chain. mechanical machining', 'mechanic', 'twice over: "mechanical" and "machining"'],
  ['ogress had triggered steep price rises', 'rigger', '"triggered"'],
  ['ne in 2022 triggered record prices', 'rigger', '"triggered"'],
  ['a contractor in west-brabant', 'able seaman', '"brabant" contains "ab"'],
  ['kandi seven ab/crane drive', 'able seaman', 'AB is the Swedish Aktiebolag suffix'],
  ['vacature windturbine monteur', 'able seaman', '"vacature" contains "ab"'],
  ['renewables, like solar and wind, offer', 'solar technician', 'prose about solar generation'],
  ['offshore wind and solar generation', 'solar technician', 'prose about solar generation'],
] as [string, string, string][]) {
  check(`"${text.slice(0, 38)}" is NOT ${mustNot}`, !has(text, mustNot), `${note}${has(text, mustNot) ? ' — MATCHED, the substring bug is back' : ''}`);
}

// The other arm: the same trades must still be found when a real advert names them.
console.log('\n--- and the same trades ARE found when an advert really says them ---');
for (const [text, must] of [
  ['Mechanic wanted for rotating equipment', 'mechanic'],
  ['Industrial Mechanics, day shift', 'mechanic'],
  ['Rigger / Slinger offshore', 'rigger'],
  ['Banksman for heavy lift campaign', 'rigger'],
  ['Solar PV Technician, Jutland', 'solar technician'],
  ['BESS Technician', 'solar technician'],
  ['Able Seaman (m/f) for PSV', 'able seaman'],
  ['able-bodied seaman', 'able seaman'],
] as [string, string][]) {
  check(`"${text}" IS ${must}`, has(text, must), has(text, must) ? 'matched' : `NOT MATCHED — ${JSON.stringify(tradesInText(text))}`);
}

// ============================================================ 2. "ab" IS EXACT-ONLY
console.log('\n--- "ab" is exact-token-only, which is a different rule from anchoring ---');
check('the field "AB" IS an able seaman', tradeOfField('AB').includes('able seaman' as any), JSON.stringify(tradeOfField('AB')));
check('the field " ab " (padded) IS an able seaman', tradeOfField('  ab  ').includes('able seaman' as any), 'trimmed and lowercased first');
check('"ab" inside prose is NOT an able seaman', !has('kandi seven ab/crane drive', 'able seaman'), 'exact terms are never asked of text');
check('the field "Kandi Seven AB" is NOT an able seaman', !tradeOfField('Kandi Seven AB').includes('able seaman' as any),
  `a company name is not a trade — ${JSON.stringify(tradeOfField('Kandi Seven AB'))}`);
check('"dpo" as a whole field IS a dp operator', tradeOfField('DPO').includes('dp operator' as any), JSON.stringify(tradeOfField('DPO')));

// ============================================================ 3. THE THREE OWNER RESOLUTIONS
console.log('\n--- the three contradictions the owner resolved on 2026-09-27 ---');
// (1) boilermaker is a SYNONYM of fitter, not a trade of its own.
check('boilermaker IS fitter', has('Boilermaker wanted', 'fitter'), JSON.stringify(tradesInText('Boilermaker wanted')));
check('boilermaker is NOT a trade of its own', !RFBT_TRADE_LIST.includes('boilermaker' as any),
  'it must not appear in the canonical list at all');
check('plater and plate worker are fitter too', has('Plater-welder', 'fitter') && has('plate worker', 'fitter'),
  'both forms of a real candidate\'s own words');

// (2) orbital welder is DISTINCT, and the span rule stops it being both.
check('orbital welder IS its own trade', has('Orbital Welder, stainless', 'orbital welder'), JSON.stringify(tradesInText('Orbital Welder, stainless')));
check('orbital welder does NOT also tag welder', !has('Orbital Welder, stainless', 'welder'),
  `span containment suppresses the inner word — ${JSON.stringify(tradesInText('Orbital Welder, stainless'))}`);
check('a plain welder advert is STILL welder', has('TIG Welder, pipe', 'welder') && !has('TIG Welder, pipe', 'orbital welder'),
  JSON.stringify(tradesInText('TIG Welder, pipe')));

// (3) anchoring, including the inconsistency that predates the new trades.
check('"pipefitter" does NOT also tag fitter', !has('Pipefitter wanted', 'fitter'),
  `both matchers now agree; jobTrades used to return both — ${JSON.stringify(tradesInText('Pipefitter wanted'))}`);
check('"pipefitter" IS pipefitter', has('Pipefitter wanted', 'pipefitter'), 'the specific one wins');
check('a plural still counts', has('Welders required', 'welder'), 'the stored vocabulary is singular; a plural must not stop counting');
check('separators are interchangeable', has('QA / QC inspector', 'qa/qc inspector') && has('qa/qc inspector', 'qa/qc inspector'),
  'a recruiter and a job board will not agree on punctuation');

// ============================================================ 4. THE NO-REGRESSION ARM
console.log('\n--- hasRfbtTrades cannot have moved for any value in the database ---');
// Exactly the distinct values measured in job_posts.trades and leads.trades_inferred on 2026-09-27.
const STORED = ['welder', 'painter', 'blaster', 'pipefitter', 'fitter', 'ndt', 'rope access', 'wind technician', 'electrician', 'scaffolder'];
for (const t of STORED) {
  check(`stored "${t}" still counts towards fit`, hasRfbtTrades([t]), categoryOf(t) ?? 'NOT IN THE VOCABULARY');
}
check('every stored value is blue_collar', STORED.every((t) => categoryOf(t) === 'blue_collar'),
  'this is the property that makes re-scoring unnecessary');
check('an empty trades array still scores nothing', !hasRfbtTrades([]), '33 of 238 leads are in this state');
check('a value that is not a trade still scores nothing', !hasRfbtTrades(['project coordination', 'logistics']), 'unchanged');

// ============================================================ 5. CATEGORIES GATE THE FIT SCORE
console.log('\n--- only blue_collar reaches the 0.4 trades weight ---');
check('a project manager does NOT earn the trades weight', !hasRfbtTrades(['project manager']),
  'white_collar: it is on every industrial project, so counting it would stop the weight discriminating');
check('the quoted-person line does NOT earn the trades weight', !hasRfbtTrades(tradesInText('ecologia project manager lucy allen')),
  'a real corpus line: a quoted person, not a vacancy — and it matched 11 articles');
check('a driller does NOT earn the trades weight', !hasRfbtTrades(['driller']),
  'drilling_crew: the corpus hits were rigs and operators ("deep value driller drillship"), never people');
check('an able seaman does NOT earn the trades weight', !hasRfbtTrades(['able seaman']), 'marine_crew');
check('a welder DOES', hasRfbtTrades(['welder']), 'blue_collar');
check('a coating inspector DOES', hasRfbtTrades(['coating inspector']), 'blue_collar — a real candidate states it');
check('white-collar roles are still FOUND, just not counted', has('Corrosion Engineer', 'corrosion engineer'),
  'the category gates the fit score, never the matching');
check('"welding engineer" is found where "welder" never matched it', has('Welding Engineer', 'welding engineer') && !has('Welding Engineer', 'welder'),
  '"welder" is not a substring of "welding", so this role was previously invisible');

// ============================================================ 6. NO DEAD TERMS, NO STRAY CATEGORIES
console.log('\n--- every term in the vocabulary is reachable, and every trade has a category ---');
for (const d of TRADES) {
  const self = tradesInText(d.trade).includes(d.trade as any);
  check(`canonical "${d.trade}" matches itself`, self, self ? (d.category as string) : 'UNREACHABLE — a term that matches nothing is worse than no term');
}
let deadAliases = 0;
for (const d of TRADES) {
  for (const a of (d as any).aliases ?? []) {
    const found = a.mode === 'exact' ? tradeOfField(a.term).includes(d.trade as any) : tradesInText(a.term).includes(d.trade as any);
    if (!found) { check(`alias "${a.term}" reaches ${d.trade}`, false, `UNREACHABLE — got ${JSON.stringify(a.mode === 'exact' ? tradeOfField(a.term) : tradesInText(a.term))}`); deadAliases++; }
  }
}
check('no dead aliases', deadAliases === 0, `${deadAliases} alias(es) match nothing`);
check('every canonical trade has a category', TRADES.every((d) => !!categoryOf(d.trade)), `${TRADES.length} trades`);
check('the canonical list has no duplicates', new Set(RFBT_TRADE_LIST).size === RFBT_TRADE_LIST.length, `${RFBT_TRADE_LIST.length} names`);
check('BLUE_COLLAR is a strict subset of the whole list', BLUE_COLLAR.every((t) => (RFBT_TRADE_LIST as readonly string[]).includes(t)) && BLUE_COLLAR.length < RFBT_TRADE_LIST.length,
  `${BLUE_COLLAR.length} of ${RFBT_TRADE_LIST.length} count towards fit`);

// ============================================================ 7. PHARMA IS DELIBERATELY ABSENT
console.log('\n--- Pharma stays tracked without trade matching (owner, 2026-09-27) ---');
for (const t of ['cleanroom operator', 'validation technician', 'cqv engineer', 'process technician']) {
  check(`"${t}" matches nothing`, tradesInText(t).length === 0,
    tradesInText(t).length ? `MATCHED ${JSON.stringify(tradesInText(t))} — Pharma was not meant to be matched` : 'absent on purpose, not by oversight');
}

// ============================================================ 8. THE SCOPE RULES, OLD AND NEW
console.log('\n--- the thirteen original scope rules are unchanged in effect ---');
for (const [text, must] of [
  ['line pipe supply for Aramco', 'welder'],
  ['pipeline integrity assessment', 'ndt'],
  ['monopile and transition piece fabrication', 'scaffolder'],
  ['EPC contract for the terminal', 'pipefitter'],
  ['blade repair campaign', 'wind technician'],
] as [string, string][]) {
  const got = inferTrades([], text).trades;
  check(`"${text}" still implies ${must}`, got.includes(must as any), JSON.stringify(got));
}
check('a scope rule never earns a white-collar trade by accident', !inferTrades([], 'line pipe supply for Aramco').trades.includes('project manager' as any),
  'the original rules gained no new trades');

console.log('\n--- and the new scope rules, each with the phrase that earns it ---');
for (const [text, must] of [
  ['heavy lift campaign, load-out from the quay', 'rigger'],
  ['crane hire for the yard', 'crane operator'],
  ['HSE management on site', 'hse officer'],
  ['coating inspection and paint inspection scope', 'coating inspector'],
  ['electrical and instrumentation package', 'instrument technician'],
  ['third-party inspection and witness points', 'qa/qc inspector'],
  ['switchgear and transformer installation', 'substation technician'],
  ['overhead line conductor stringing', 'lineworker'],
  ['pump overhaul and shaft alignment', 'millwright'],
  ['precision engineering and CNC machining', 'machinist'],
  ['drill floor and rig crew supply', 'roughneck'],
  ['vessel crew for a DP2 unit', 'dp operator'],
  ['ROV survey and diving support spread', 'commercial diver'],
  ['solar park and battery energy storage', 'solar technician'],
  ['construction management and site supervision', 'site manager'],
  ['cathodic protection and corrosion management', 'corrosion engineer'],
  ['welding procedure qualification, WPQR', 'welding engineer'],
] as [string, string][]) {
  const got = inferTrades([], text).trades;
  check(`"${text.slice(0, 42)}" implies ${must}`, got.includes(must as any), got.includes(must as any) ? 'inferred' : `NOT INFERRED — ${JSON.stringify(got)}`);
}

// NAMING-INDEPENDENT ARMS, added after a mutation showed the assertions above were not enough. Renaming
// `solar technician` back to the handover's bare `solar` failed only the POSITIVE arms — the prose arms
// still passed, because they name the trade they expect to be absent, and under that mutation no trade
// is called "solar technician" at all. An assertion that cannot fail when the bug is reintroduced is
// exactly the vacuous kind this file exists to avoid, so these ask about the RESULT rather than a name.
console.log('\n--- naming-independent: solar prose must yield NO trade whatsoever ---');
for (const prose of ['renewables, like solar and wind, offer', 'offshore wind and solar generation', 'as wind or solar. without subsidy']) {
  check(`"${prose.slice(0, 40)}" yields no trade at all`, tradesInText(prose).length === 0,
    tradesInText(prose).length ? `MATCHED ${JSON.stringify(tradesInText(prose))} — a solar article is not a vacancy` : 'empty, as prose must be');
}
check('"solar" is not a canonical trade on its own', !(RFBT_TRADE_LIST as readonly string[]).includes('solar'),
  'the bare word matched 94 articles; the role words are the trade');

// The other arm for the one new rule narrow enough to be broken by widening it: "quality control" is
// ordinary prose in a contract announcement, so the rule requires a scope word after it.
check('bare "quality control" is NOT a qa/qc inspector scope',
  !inferTrades([], 'the company maintains strict quality control').trades.includes('qa/qc inspector' as any),
  'a scope word is required — otherwise every contract announcement matches');
check('"quality control inspection" IS',
  inferTrades([], 'quality control inspection scope').trades.includes('qa/qc inspector' as any), 'with a scope word it fires');

console.log(`\ntrades: ${fail ? `${fail} FAILED` : 'all checks passed'}`);
if (fail) process.exitCode = 1;
