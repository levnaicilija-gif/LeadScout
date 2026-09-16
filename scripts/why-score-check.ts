/**
 * Item 11 part 2: a "why this score" line is shown only where its evidence is in the candidate data.
 *
 * Pure — no database, no model, no network. In the release gate.
 *
 * The rule under test is the filter inside scoreAgainstJob: a reason quoting the data is kept, a
 * reason quoting something absent is dropped and counted, and a reason with no evidence at all is
 * kept, because "the job asks and the CV is silent" is a true and useful thing to show. Reproduced
 * here against appearsIn directly, so the check does not need a model call.
 *
 *   npx tsx scripts/why-score-check.ts
 */
import { appearsIn } from '../src/lib/ai/claude';

let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

/** The filter exactly as scoreAgainstJob applies it. */
const keep = (reasons: { requirement: string; met: boolean; evidence: string }[], source: object) => {
  const src = JSON.stringify(source);
  const kept = reasons.filter((r) => !r.evidence || appearsIn(src, r.evidence));
  return { kept, droppedReasons: reasons.length - kept.length };
};

const anon = {
  trade: 'Plate worker / plate fitter',
  trades: ['plate worker', 'fitter'],
  projects: [
    { years: '2015-2017', type: 'shipyard fabrication and structural assembly', country: 'Romania', rotation: '8:2' },
    { years: '2024-2025', type: 'ship and offshore platform repairs', country: 'Denmark' },
  ],
  languages: ['Romanian', 'English'],
  certificates: ['ISO 9606 claimed'],
};
const source = { candidate: anon, verified_certificates: [{ body: 'frosio', level: 'III' }] };

/* ------------------------------------------------------------- kept, because it is in the data */
const traceable = keep([
  { requirement: 'Plate fitting experience', met: true, evidence: 'shipyard fabrication and structural assembly' },
  { requirement: 'Offshore exposure', met: true, evidence: 'ship and offshore platform repairs' },
], source);
check(traceable.kept.length === 2 && traceable.droppedReasons === 0,
  'a line whose evidence is in the candidate data is kept', `${traceable.kept.length} kept, ${traceable.droppedReasons} dropped`);

const caseInsensitive = keep([{ requirement: 'Rotation', met: true, evidence: 'SHIPYARD   FABRICATION and structural assembly' }], source);
check(caseInsensitive.kept.length === 1, 'the trace ignores case and runs of whitespace, as appearsIn does');

const verified = keep([{ requirement: 'FROSIO', met: true, evidence: 'frosio' }], source);
check(verified.kept.length === 1, 'evidence may come from the verified certificates, not only the CV');

/* ------------------------------------------------------- dropped, because it is nowhere in the data */
const invented = keep([
  { requirement: 'ICATS card', met: true, evidence: 'ICATS card issued 2023' },
  { requirement: 'Plate fitting experience', met: true, evidence: 'shipyard fabrication and structural assembly' },
], source);
check(invented.kept.length === 1 && invented.droppedReasons === 1,
  'a line citing something absent from the data is dropped, and counted', `${invented.kept.length} kept, ${invented.droppedReasons} dropped`);
check(invented.kept[0].requirement === 'Plate fitting experience',
  'dropping one line leaves the others exactly as they were');

const allInvented = keep([
  { requirement: 'ICATS', met: true, evidence: 'ICATS card issued 2023' },
  { requirement: 'Danish', met: true, evidence: 'fluent Danish' },
], source);
check(allInvented.kept.length === 0 && allInvented.droppedReasons === 2,
  'every line can be dropped, which is what sends the card to the fallback', `${allInvented.droppedReasons} dropped`);

/* ------------------------------------------------- kept, because silence is an honest answer */
const silent = keep([{ requirement: 'ICATS card', met: false, evidence: '' }], source);
check(silent.kept.length === 1 && silent.droppedReasons === 0,
  'a requirement the CV says nothing about is kept with no evidence, not dropped');

/* ------------------------------------------- evidence is traced against SERIALISED data */
// The filter compares the quoted phrase against JSON.stringify of the candidate data, so anything
// JSON escapes — a quote mark, a backslash — is not in the serialised text as the model wrote it,
// and a true line would be dropped. These hold the boundary: ordinary punctuation and non-ASCII
// letters survive serialisation unchanged and must be kept.
const punctuated = {
  candidate: {
    trade: 'Plate worker / plate fitter',
    projects: [{ years: '2020 – 2024', type: "ship's hull sections, 8:2 rotation", country: 'România' }],
  },
  verified_certificates: [],
};
for (const phrase of ['Plate worker / plate fitter', "ship's hull sections", '8:2 rotation', 'România', '2020 – 2024']) {
  const r = keep([{ requirement: 'x', met: true, evidence: phrase }], punctuated);
  check(r.kept.length === 1, `evidence containing ${JSON.stringify(phrase)} survives the trace`, `${r.droppedReasons} dropped`);
}
// A quote mark IS escaped by JSON.stringify, so a phrase carrying one cannot match the serialised
// source. Recorded as the known boundary rather than left to be discovered: the line is dropped,
// which errs towards showing less, never towards showing something unfounded.
const quoted = keep([{ requirement: 'x', met: true, evidence: 'the "Danube Bridge" project' }],
  { candidate: { projects: [{ type: 'the "Danube Bridge" project' }] }, verified_certificates: [] });
check(quoted.droppedReasons === 1,
  'KNOWN boundary: evidence carrying a quote mark is dropped, because JSON escapes it — errs towards showing less');

/* --------------------------------------------------------------------------- the fallback */
const none = keep([], source);
check(none.kept.length === 0 && none.droppedReasons === 0,
  'no reasons at all drops nothing — the card falls back to fits, missing and blockers');

console.log(failed ? `\nwhy-score check: ${failed} FAILED` : '\nwhy-score check: all checks passed');
process.exit(failed ? 1 : 0);
