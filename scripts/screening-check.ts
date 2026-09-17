/**
 * Item 5 part 3: only a recruiter's own verdict may mark a re-score, and prose never does.
 *
 * Pure — no database, no model, no network. In the release gate.
 *
 * This is where the owner's decision of 2026-09-16 is pinned down: deterministic verdicts only
 * (right to work, certificates), prose stored and shown but never interpreted, and a marked call
 * never rewrites the stored score — it asks for a re-score against its own lead_id/jd_version.
 *
 *   npx tsx scripts/screening-check.ts
 */
import { rescoreReason, rescoreFor, takesVerdict, verdictAllowed, progress, STANDARD_QUESTIONS, withStandardQuestions, type AnswerRow, type CallFlag } from '../src/lib/screening';

let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const a = (over: Partial<AnswerRow>): AnswerRow => ({ position: 0, question: 'q', kind: 'open', ...over });

/* --------------------------------------------------------- which kinds take a verdict at all */
check(takesVerdict('right_to_work') && takesVerdict('certificate'), 'right to work and certificates take a verdict');
check(!takesVerdict('open') && !takesVerdict('rate') && !takesVerdict('availability'),
  'prose questions — open, rate, availability — take none');
check(verdictAllowed('right_to_work', 'no') && !verdictAllowed('right_to_work', 'confirmed'),
  'a kind only accepts its own verdicts');
check(!verdictAllowed('open', 'no'), 'a verdict on an open question counts for nothing');

/* ------------------------------------------------------------------- what marks a re-score */
const refused = rescoreReason([a({ kind: 'right_to_work', verdict: 'no', answer: 'No EU passport.' })]);
check(!!refused && /right to work was refused/.test(refused), 'right to work refused marks a re-score', String(refused));
check(!!refused && /score again against this job/.test(refused), 'and it says what to do about it', String(refused));

const confirmed = rescoreReason([a({ kind: 'certificate', subject: 'ISO 9606 6G', verdict: 'confirmed' })]);
check(!!confirmed && /ISO 9606 6G was confirmed/.test(confirmed), 'a confirmed certificate marks one, and names it', String(confirmed));

const notConfirmed = rescoreReason([a({ kind: 'certificate', subject: 'BOSIET', verdict: 'not_confirmed' })]);
check(!!notConfirmed && /BOSIET could not be confirmed/.test(notConfirmed), 'so does one that could not be confirmed', String(notConfirmed));

const anonymousCert = rescoreReason([a({ kind: 'certificate', verdict: 'confirmed' })]);
check(!!anonymousCert && /a certificate was confirmed/.test(anonymousCert), 'a certificate with no subject still marks one, without inventing a name', String(anonymousCert));

/* ------------------------------------------------------------------ what does NOT mark one */
check(rescoreReason([]) === null, 'a call with no answers marks nothing');
check(rescoreReason([a({ kind: 'right_to_work', verdict: 'yes' })]) === null, 'right to work confirmed marks nothing — it changes no blocker');
check(rescoreReason([a({ kind: 'right_to_work', verdict: 'unclear' })]) === null, '"unclear" marks nothing: it is not a fact yet');
check(rescoreReason([a({ kind: 'right_to_work' })]) === null, 'a question left unanswered marks nothing');

// The whole point of the owner's decision: prose is never read for meaning.
const prose = rescoreReason([
  a({ kind: 'open', answer: 'He said his 6G lapsed in March and he has no EU passport.' }),
  a({ kind: 'rate', answer: 'Wants 20% over the rate. Cannot work for Aker again.' }),
  a({ kind: 'availability', answer: 'Not available, and his medical expired.' }),
]);
check(prose === null, 'prose that would disqualify anybody marks nothing — only a verdict does', String(prose));

// A verdict on a kind that may not carry one is ignored rather than honoured.
check(rescoreReason([a({ kind: 'open', verdict: 'no' })]) === null, 'a "no" on an open question is ignored');
check(rescoreReason([a({ kind: 'rate', verdict: 'not_confirmed' })]) === null, 'a certificate verdict on a rate question is ignored');
check(rescoreReason([a({ kind: 'certificate', verdict: 'no' })]) === null, 'a right-to-work verdict on a certificate question is ignored');

/* ----------------------------------------------------------------------- several at once */
const both = rescoreReason([
  a({ position: 0, kind: 'right_to_work', verdict: 'no' }),
  a({ position: 1, kind: 'certificate', subject: 'FROSIO III', verdict: 'confirmed' }),
  a({ position: 2, kind: 'open', answer: 'Long chat about the North Sea.' }),
]);
check(!!both && /right to work was refused.*FROSIO III was confirmed/.test(both),
  'every verdict is named, in the order the questions were asked', String(both));

/* ------------------------------------------------- the seven that are always asked, whatever the job */
// Written in code, not by the model: their kind decides which verdict control appears on the call,
// and a mislabel would remove one silently (owner's decision, 2026-09-17).
check(STANDARD_QUESTIONS.length === 7, 'seven standard questions', `${STANDARD_QUESTIONS.length}`);
check(STANDARD_QUESTIONS.every((s) => s.q.trim() && s.good_answer.trim()),
  'each has a question and what a good answer sounds like');
check(STANDARD_QUESTIONS.some((s) => s.kind === 'certificate'), 'one asks about certificates, and takes a confirm');
check(STANDARD_QUESTIONS.some((s) => s.kind === 'availability'), 'one asks about starting');
check(STANDARD_QUESTIONS.some((s) => s.kind === 'rate'), 'one asks about money');
check(STANDARD_QUESTIONS.some((s) => /non.?compete|cannot work for/i.test(s.q)), 'one asks about conflicts — the mock had it, the prompt never did');
check(!STANDARD_QUESTIONS.some((s) => s.kind === 'right_to_work'),
  'right to work is NOT here — both routes inject it first, so a "no" is never the eighth question');
check(STANDARD_QUESTIONS.every((s) => takesVerdict(s.kind) || s.kind === 'open' || s.kind === 'availability' || s.kind === 'rate'),
  'every kind is one the call knows how to render');

const modelWrote = [
  { q: 'Which positions are on your ISO 9606, and what thickness have you welded to ISO 5817 level B?' },
  { q: 'What rate are you expecting?' },                       // the model reached for a standard one
  { q: 'Tell me about the gap between 2021 and 2022.' },
];
const merged = withStandardQuestions(modelWrote);
check(merged.length === 2 + 7, "the model's own questions are kept and the seven appended", `${merged.length}`);
check(!merged.some((m) => m.q === 'What rate are you expecting?'),
  "a model-written duplicate of standard ground is dropped, not the fixed one — the fixed one's kind is certain");
check(merged.some((m) => (m as any).kind === 'rate'), 'and the fixed rate question is the one that survived');
check(merged.slice(-7).every((m) => STANDARD_QUESTIONS.includes(m as any)), 'the seven come last, after what the score raised');
check(withStandardQuestions([]).length === 7, 'a model that returns nothing still leaves a full standard set');

// The dedupe must not eat the questions step 3 exists to produce. The first cut keyed on subject
// matter and swallowed every one of these (2026-09-17); they name a certificate or a rate because
// they are asking for SPECIFICS, which is the opposite of the standard inventory question.
const probes = [
  'Which positions are on your ISO 9606, and what thickness have you welded to ISO 5817 level B?',
  'Your CV claims FROSIO III — which inspections did you sign off, and to what acceptance criteria?',
  'You list CSWIP 3.1 — was that on plate or pipe, and what was the scope?',
  'What deposition rate did you hold on the 25 mm root runs?',
  'The CV says offshore medical — which clinic, and what did it cover?',
];
for (const q of probes) {
  const survived = withStandardQuestions([{ q }]).some((m) => m.q === q);
  check(survived, `a doubtful-fit probe survives the dedupe: ${q.slice(0, 52)}…`);
}
// And the genuine duplicates still go — BOTH arms of every row, because a rule that only proves the
// survive side can be narrowed until it catches nothing and still read as passing. Row three was
// reshaped twice before this existed, and each round the check reported a number rather than a cause.
const duplicates: [string, string][] = [
  ['certificates', 'Which certificates do you hold, and when does each expire?'],
  ['rotation', 'What rotation have you worked, and what would you take now?'],
  ['medical and safety', 'Offshore medical and safety training — BOSIET, GWO, VCA: what is valid, and until when?'],
  ['English on site', 'English on site — could you follow a toolbox talk and a permit to work?'],
  ['starting', 'What is your earliest start, and what notice do you owe anyone?'],
  ['rate', 'What rate are you expecting, all in?'],
  ['conflicts', 'Is there any client you cannot work for — a non-compete, or somewhere you left badly?'],
];
for (const [row, q] of duplicates) {
  const survived = withStandardQuestions([{ q }]).some((m, i, all) => m.q === q && all.indexOf(m) < all.length - 7);
  check(!survived, `${row}: a model writing the standard question itself is dropped, and the fixed one kept`);
}
// Every row must catch something: a pattern narrowed until it matches nothing passes the survive
// assertions and silently stops deduplicating at all.
check(withStandardQuestions(duplicates.map(([, q]) => ({ q }))).length === 7,
  'a model that writes all seven standard questions leaves exactly seven — one per row, none doubled', `${withStandardQuestions(duplicates.map(([, q]) => ({ q }))).length}`);

/* ------------------------------- which call the score card may speak for (lead AND jd_version) */
const call = (over: Partial<CallFlag>): CallFlag => ({
  candidate_id: 'cand', lead_id: 'lead', jd_version: 2,
  needs_rescore: true, rescore_reason: 'right to work was refused on the call', finished_at: '2026-09-17T10:00:00Z',
  ...over,
});

check(rescoreFor([call({})], 'cand', 'lead', 2) === 'right to work was refused on the call',
  'a finished call against this lead at this version speaks for itself');
check(rescoreFor([call({})], 'cand', 'lead', 3) === null,
  'the SAME call says nothing once the JD is rewritten to version 3 — a flag must not survive a rewrite');
check(rescoreFor([call({ jd_version: 3 })], 'cand', 'lead', 2) === null,
  'nor does a call answered against a newer version speak for an older score');
check(rescoreFor([call({})], 'cand', 'other-lead', 2) === null, 'a call about another lead says nothing here');
check(rescoreFor([call({})], 'someone-else', 'lead', 2) === null, 'nor does another candidate\'s call');
check(rescoreFor([call({ finished_at: null })], 'cand', 'lead', 2) === null,
  'a call still in progress says nothing — needs_rescore is only settled when it is finished');
check(rescoreFor([call({ needs_rescore: false, rescore_reason: null })], 'cand', 'lead', 2) === null,
  'a finished call that marked nothing says nothing');
check(rescoreFor([], 'cand', 'lead', 2) === null, 'no calls at all says nothing');
check(rescoreFor([call({ jd_version: null })], 'cand', 'lead', null) === 'right to work was refused on the call',
  'a call with no JD version speaks for a score with no JD version');
check(rescoreFor([call({ jd_version: null })], 'cand', 'lead', 2) === null,
  'but "no version" is not a wildcard — it does not speak for version 2');
check(rescoreFor([
  call({ finished_at: '2026-09-17T09:00:00Z', rescore_reason: 'the older call' }),
  call({ finished_at: '2026-09-17T11:00:00Z', rescore_reason: 'the newer call' }),
], 'cand', 'lead', 2) === 'the newer call', 'the newest finished call is the one that speaks');

/* ------------------------------------------------------------------------------ progress */
const p = progress([a({ answer: 'said something' }), a({ verdict: 'yes', kind: 'right_to_work' }), a({}), a({ answer: '   ' })]);
check(p.done === 2 && p.total === 4, 'an answer counts as given with prose OR a verdict; blank space is not an answer', JSON.stringify(p));

console.log(failed ? `\nscreening check: ${failed} FAILED` : '\nscreening check: all checks passed');
process.exit(failed ? 1 : 0);
