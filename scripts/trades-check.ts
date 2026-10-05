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
// The crawl's own title taxonomy, read from the module that builds it: the point of item 32's third part is
// that the prompt and the vocabulary are ONE source, so the check must read the real string, not a copy.
import { TITLE_TAXONOMY, TITLE_MAX_TOKENS, TITLE_SYSTEM as TITLE_SYSTEM_TEXT } from '../src/lib/jobs/job-posts-batch';

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

// ============================================================ 3b. THE ACTIVITY NAMES THE TRADE
// Added 2026-09-27 on the owner's instruction, from a real record: before these two aliases the candidate
// below resolved to ["coating inspector"] alone, because `painter` is not a substring of "painting" nor
// `blaster` of "blasting", so the two trades that person actually works in were invisible on their record.
console.log('\n--- "painting" and "blasting" name the trade on a stated field ---');
check('"painting" IS painter', has('Painting supervisor', 'painter'), JSON.stringify(tradesInText('Painting supervisor')));
check('"blasting" IS blaster', has('Blasting operative', 'blaster'), JSON.stringify(tradesInText('Blasting operative')));
const real = 'Coating Inspector / QC Project Coordinator (painting & blasting background)';
check('the real candidate record now resolves to all three trades',
  ['coating inspector', 'painter', 'blaster'].every((t) => tradeOfField(real).includes(t as any)),
  `${JSON.stringify(tradeOfField(real))} — it answered ["coating inspector"] alone before`);
check('and "Industrial painter / blaster" is unchanged', JSON.stringify(tradeOfField('Industrial painter / blaster')) === JSON.stringify(['painter', 'blaster']),
  JSON.stringify(tradeOfField('Industrial painter / blaster')));
// THE LIMIT, asserted rather than left to be discovered: anchoring leaves "sandblasting" unmatched, because
// the preceding "d" is a word character. Measured the day this shipped — sandblast* appears 0 times in every
// advert and every candidate trade on file — so this is pinned as KNOWN, and the fix when it appears is its
// own alias, never dropping the anchor. An unanchored trade term costs more than a missing one.
check('"sandblasting" is still unmatched, and that is recorded rather than accidental',
  tradesInText('sandblasting').length === 0 && tradesInText('sandblaster').length === 0,
  `${JSON.stringify(tradesInText('sandblasting'))} / ${JSON.stringify(tradesInText('sandblaster'))} — 0 occurrences on file today; add an alias if that changes`);
// And the arm that stops this widening into prose: a scope description already had a route through
// SCOPE_RULES, so these aliases must not be what makes a project imply painters.
check('a coating SCOPE still implies painter and blaster through the rules, not through these aliases',
  inferTrades([], 'surface treatment and coating scope').trades.includes('painter' as any),
  JSON.stringify(inferTrades([], 'surface treatment and coating scope').trades));

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

// ---- ITEM 32's two measured false positives, both arms each -------------------------------------------
// Each was found by running the real corpus, not by reading the list, and each is asserted in BOTH
// directions: the real title it must still match, and the measured prose it must no longer match. A
// one-sided arm would pass if the term were deleted outright, which is not the fix either.
console.log('\n--- item 32: the two false positives the expansion introduced ---');

// 1. `dogger` matched DOGGER BANK in 11 articles, in a corpus largely about offshore wind.
// "Doggerbank" as one closed word was deliberately dropped from this list: the mutation that restores the
// alias does NOT make it fail, because `\b` never matched inside the compound in the first place. It asserted
// something true and unattributable, which is the vacuous kind this file exists to avoid.
for (const prose of ['Dogger Bank wind farm', 'the Dogger Bank C project']) {
  check(`"${prose}" yields no rigger`, !tradesInText(prose).includes('rigger' as any),
    tradesInText(prose).includes('rigger' as any) ? 'MATCHED rigger — the place name is not a trade' : 'not matched, as a place name must not be');
}
check('"dogger" is not a term at all any more', tradesInText('dogger').length === 0,
  tradesInText('dogger').length ? `MATCHED ${JSON.stringify(tradesInText('dogger'))}` : 'gone');
// The trade itself must survive its alias being dropped — otherwise this reads as a fix and is a deletion.
check('rigger still matches its own name', tradesInText('Rigger / Slinger wanted').includes('rigger' as any), 'rigger intact');
check('banksman still maps to rigger', tradesInText('Banksman needed offshore').includes('rigger' as any), 'the surviving alias still fires');

// 2. `mechanic` matched the PLURAL, which the default trailing `s?` allows: "mechanics" is a field of study.
for (const prose of ['quantum mechanics research', 'rock mechanics and soil behaviour', 'fluid mechanics modelling']) {
  check(`"${prose}" yields no mechanic`, !tradesInText(prose).includes('mechanic' as any),
    tradesInText(prose).includes('mechanic' as any) ? 'MATCHED mechanic — a field of study is not a trade' : 'not matched');
}
check('"Mechanic" the title still matches', tradesInText('Industrial Mechanic (day shift)').includes('mechanic' as any), 'the singular title still fires');
// THE ARM THAT KILLED THE FIRST ATTEMPT, asserted here as well as above so the trade-off cannot be lost: the
// PLURAL JOB TITLE must still match. Suppressing the trailing plural stopped "quantum mechanics" and broke
// this, which is why the rule is a qualifier lookbehind and not a singular-only term.
check('"Industrial Mechanics" (plural TITLE) still matches', tradesInText('Industrial Mechanics, day shift').includes('mechanic' as any),
  'the plural title survives — only the field-of-study qualifiers are refused');
check('"mechanical" still does not match', !tradesInText('mechanical solutions provider').includes('mechanic' as any), 'the original anchoring holds');
// The qualifier must be refused only IMMEDIATELY before the word, or the rule would silence a whole sentence.
check('a mechanic later in a sentence about rock is still found',
  tradesInText('rock excavation on site; we need a mechanic').includes('mechanic' as any),
  'the lookbehind binds to the word in front, not to the sentence');
// The plural must still work for every OTHER trade, or the rule has leaked from one term to all of them.
check('"welders" (plural) still matches welder', tradesInText('Welders wanted, 6G').includes('welder' as any),
  'the plural is still the default everywhere else');
check('"scaffolders" (plural) still matches scaffolder', tradesInText('Scaffolders required').includes('scaffolder' as any), 'default plural intact');

// ---- ITEM 32's third part: the crawl's title prompt speaks the WHOLE vocabulary ------------------------
// The prompt is generated from TRADE_NAMES, and this asserts the generated string really does carry every
// trade — not that the join exists. A hand-typed list drifted silently once and cost 97% of 7,722 titles.
console.log('\n--- item 32: the title prompt names every trade in the vocabulary ---');
const missingFromPrompt = (RFBT_TRADE_LIST as readonly string[]).filter((t) => !TITLE_TAXONOMY.includes(t));
check(`all ${RFBT_TRADE_LIST.length} trades are in the crawl's title taxonomy`, missingFromPrompt.length === 0,
  missingFromPrompt.length ? `MISSING ${JSON.stringify(missingFromPrompt)} — the crawl cannot keep a title it is not told about` : 'every one present');
check('the taxonomy is not the old ten words', RFBT_TRADE_LIST.length > 10 && TITLE_TAXONOMY.includes('rigger'),
  'rigger reaches the prompt, which it could not before');

// THE TOKEN CEILING IS PART OF THE SAME CHANGE, and this arm exists because widening the taxonomy without
// raising it would have lost whole boards. The reply is one object per KEPT title, and at 500 tokens it was
// already truncating on the TEN-word list (EnerMech and mennens, "Expected ',' or ']' ... position 1201").
// The largest board this crawl has met is 60 titles; a verdict entry is ~45 characters, so a board where
// every title is kept needs roughly 2,700 characters of JSON — about 700 tokens.
const WORST_BOARD_TITLES = 60;
const CHARS_PER_VERDICT = 45;
const CHARS_PER_TOKEN = 4;
const neededTokens = Math.ceil((WORST_BOARD_TITLES * CHARS_PER_VERDICT) / CHARS_PER_TOKEN);
check(`the title ceiling fits the worst board seen (${WORST_BOARD_TITLES} titles, about ${neededTokens} tokens)`,
  TITLE_MAX_TOKENS >= neededTokens,
  TITLE_MAX_TOKENS >= neededTokens ? `${TITLE_MAX_TOKENS} tokens, with headroom` : `${TITLE_MAX_TOKENS} is BELOW the ${neededTokens} a full board needs — boards would truncate and be lost whole`);
check('the old 500-token ceiling would NOT have fitted it', 500 < neededTokens,
  'which is why two boards were already failing to parse before the taxonomy was widened');

// ---- ITEM 47: THE TITLE PROMPT CARRIES BOTH ARMS, NOT JUST THE REFUSALS ------------------------------
// A prompt cannot be unit-tested — only the live crawl can say what the model does with it — so what IS
// testable is that NEITHER SIDE OF THE RULE HAS BEEN DELETED. This exists because 46(a) shipped the refusals
// ALONE and over-corrected: Equinor went from keeping 3 of 11 to keeping 0, and two of those three were real
// trade adverts ("Fagoperatør Mekanisk", "Offshore Operations & Maintenance Technician"). A one-sided rule in
// a prompt over-reaches exactly the way a one-sided regex does, and this file already knows that about regexes.
console.log('\n--- item 47: the title prompt refuses a bare "operator" AND keeps a trade beside one ---');
for (const refuse of ['Control Room Operator', 'Operator Tysvær', 'Trencher Operator Trainee', 'Machine Operator']) {
  check(`the prompt still names "${refuse}" as a title to refuse`, TITLE_SYSTEM_TEXT.includes(refuse),
    TITLE_SYSTEM_TEXT.includes(refuse) ? 'present' : 'MISSING — the refusal half has been deleted');
}
for (const keep of ['Fagoperatør Mekanisk', 'Offshore Operations & Maintenance Technician', 'DP Operator', 'Crane Operator']) {
  check(`and still names "${keep}" as one to KEEP`, TITLE_SYSTEM_TEXT.includes(keep),
    TITLE_SYSTEM_TEXT.includes(keep) ? 'present' : 'MISSING — the positive half is gone, which is what over-corrected Equinor to 0 of 11');
}
// The two halves must be distinguishable, not merely both present: a prompt listing a title under BOTH
// headings would satisfy every assertion above while telling the model nothing.
const refuseBlock = TITLE_SYSTEM_TEXT.slice(TITLE_SYSTEM_TEXT.indexOf('titles to REFUSE'), TITLE_SYSTEM_TEXT.indexOf('BUT A TITLE THAT NAMES A TRADE'));
check('"Fagoperatør Mekanisk" is NOT inside the refuse block', !refuseBlock.includes('Fagoperatør'),
  'the keep example must not sit under the refusals, or the prompt contradicts itself');
check('"Control Room Operator" IS inside the refuse block', refuseBlock.includes('Control Room Operator'),
  'and the refusal must actually be under the refusals');

console.log(`\ntrades: ${fail ? `${fail} FAILED` : 'all checks passed'}`);
if (fail) process.exitCode = 1;
