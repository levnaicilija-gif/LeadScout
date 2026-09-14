/** The careers-page verdict rule: npx tsx scripts/employer-verdict-check.ts */
import { verdictPatch } from '../src/lib/employer-verdict';

let failed = 0;
const check = (ok: boolean, what: string, got: unknown) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — ${JSON.stringify(got)}`}`); if (!ok) failed++; };
const now = '2026-09-15T00:10:00.000Z';

// EnBW: a name guess the page does not settle stays a name guess.
let r = verdictPatch({ employer_type: 'epc_contractor', employer_type_source: 'name' }, { employer_type: 'unknown', evidence: 'The page lists roles only.' }, now);
check(r.patch.employer_type === undefined && r.patch.employer_type_source === 'name' && r.changedTo === null, 'a name guess the page does not settle keeps its type and stays labelled a name guess', r);

// EnBW corrected: the page says it owns the asset.
r = verdictPatch({ employer_type: 'epc_contractor', employer_type_source: 'name' }, { employer_type: 'end_client', evidence: 'Owns and operates offshore wind farms.' }, now);
check(r.patch.employer_type === 'end_client' && r.patch.employer_type_source === 'careers_page' && r.changedTo === 'end_client', 'a page that says what the company is replaces the name guess', r);

// A careers-page answer is not traded for unknown, and stays a careers-page answer.
r = verdictPatch({ employer_type: 'end_client', employer_type_source: 'careers_page' }, { employer_type: 'unknown', evidence: 'Nothing on the page.' }, now);
check(r.patch.employer_type === undefined && r.patch.employer_type_source === undefined && r.changedTo === null, 'an earlier careers-page answer survives an unknown', r);

// Unknown before, unknown after: recorded as read, no change.
r = verdictPatch({ employer_type: null, employer_type_source: null }, { employer_type: 'unknown', evidence: 'No description.' }, now);
check(r.patch.employer_type === 'unknown' && r.patch.employer_type_checked_at === now && r.changedTo === 'unknown', 'an unknown company read as unknown is recorded as read', r);

// A name guess the page confirms becomes a careers-page answer.
r = verdictPatch({ employer_type: 'epc_contractor', employer_type_source: 'name' }, { employer_type: 'epc_contractor', evidence: 'We fabricate and install.' }, now);
check(r.patch.employer_type_source === 'careers_page' && r.changedTo === null, 'a name guess the page confirms is labelled a careers-page answer, with no change counted', r);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
