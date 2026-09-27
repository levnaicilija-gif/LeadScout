/**
 * The status vocabularies in code match what the database actually accepts.
 *
 *   npx tsx --env-file=.env.local scripts/status-vocabulary-check.ts
 *
 * THE CLASS THIS CLOSES is a string in code that must equal something the database enforces, where getting
 * it wrong fails only when that exact path runs. There are two vocabularies here and they differ by ONE
 * LETTER — a lead is 'pursue' (the lead_status enum) and a company is 'pursued' (a check constraint on
 * workspace_company_state.hiring_status) — so the wrong one is a plausible typo that Postgres rejects with
 * 22P02 or a constraint violation, not a compile error. Found by audit on 2026-09-28 with no live mismatch.
 *
 * BOTH DIRECTIONS, because one direction is useless. A code list missing a value the database accepts means
 * rows the app silently refuses to handle; a code list containing a value the database rejects means a 500
 * the first time somebody clicks it. Asserting only "every code value is valid" passes on a list that has
 * been narrowed to nothing.
 *
 * THE ENUM IS CHECKED LIVE. PostgREST's OpenAPI document publishes an enum's values, so LEAD_STATUSES is
 * compared against the real database — no invocation, no writes, one read.
 *
 * THE CHECK CONSTRAINT CANNOT BE, and that limit is the interesting half. `hiring_status` is a CHECK, not an
 * enum, so OpenAPI reports it as plain `text` with no values at all. Probing it by write is the only live
 * option and Postgres validates a constraint only on rows actually written, so an update matching no rows
 * proves nothing. HIRING_STATUSES is therefore compared against the migration that created it — sound here
 * because "every structural change goes through a numbered migration, never the dashboard" is a hard rule
 * in this codebase, which makes the migration the source of truth rather than a stale copy of one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEAD_STATUSES, ACTIVE_LEAD_STATUSES, CLOSED_LEAD_STATUS_LIST, HIRING_STATUSES,
  isLeadStatus, isHiringStatus,
} from '../src/lib/statuses';
import { CLOSED_LEAD_STATUSES } from '../src/lib/workspace-state';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let fail = 0;
const check = (name: string, pass: boolean, detail: string) => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!pass) fail++;
};
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/** The values an ENUM-backed column accepts, read from PostgREST's OpenAPI document. */
async function liveEnum(table: string, column: string): Promise<string[] | null> {
  const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`the OpenAPI document could not be read: ${res.status}`);
  const spec: any = await res.json();
  const defs = spec?.definitions ?? spec?.components?.schemas ?? {};
  const prop = defs?.[table]?.properties?.[column];
  if (!prop) throw new Error(`${table}.${column} is not in the OpenAPI document at all — refusing to judge the list against nothing`);
  return Array.isArray(prop.enum) ? prop.enum : null;
}

/** The values a CHECK constraint allows, parsed from the migration that declares it. */
function constraintValues(column: string): string[] {
  const dir = 'supabase/migrations';
  const found: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, f), 'utf8');
    // check (hiring_status in ('new','pursued','not_for_us'))
    const re = new RegExp(`check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`, 'ig');
    for (const m of sql.matchAll(re)) {
      const vals = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
      if (vals.length) found.length = 0, found.push(...vals);   // a later migration replaces an earlier one
    }
  }
  return found;
}

(async () => {
  if (!url || !key) { console.error('URL and SERVICE_ROLE_KEY are required'); process.exitCode = 1; return; }

  // ---- 1. THE ENUM, against the live database, both directions ------------------------------------
  const live = await liveEnum('workspace_lead_state', 'status');
  check('lead_status is still an ENUM the database publishes', Array.isArray(live) && live.length > 0,
    live ? `${live.length} value(s): ${live.join(', ')}` : 'NOT AN ENUM any more — the check below cannot be trusted');
  if (live) {
    check('every LEAD_STATUSES value is one the database accepts',
      LEAD_STATUSES.every((s) => live.includes(s)),
      `code has ${LEAD_STATUSES.length}; rejected by the database: ${LEAD_STATUSES.filter((s) => !live.includes(s)).join(', ') || 'none'}`);
    check('and every value the database accepts is in LEAD_STATUSES',
      live.every((s) => (LEAD_STATUSES as readonly string[]).includes(s)),
      `missing from code: ${live.filter((s) => !(LEAD_STATUSES as readonly string[]).includes(s)).join(', ') || 'none'}`);
    check('the two lists are exactly equal', same(LEAD_STATUSES, live), `${LEAD_STATUSES.length} vs ${live.length}`);
  }

  // ---- 2. THE SUBSETS add up, so no status is unreachable -----------------------------------------
  const covered = [...ACTIVE_LEAD_STATUSES, ...CLOSED_LEAD_STATUS_LIST, 'new'];
  check('active + closed + "new" accounts for EVERY lead status', same(covered, LEAD_STATUSES),
    `${covered.length} accounted for of ${LEAD_STATUSES.length}; unaccounted: ${LEAD_STATUSES.filter((s) => !covered.includes(s)).join(', ') || 'none'}`);
  check('active and closed do not overlap',
    !ACTIVE_LEAD_STATUSES.some((s) => (CLOSED_LEAD_STATUS_LIST as readonly string[]).includes(s)),
    'a status cannot be both being worked and finished with');
  // The PostgREST filter string must say the same thing as the array, or a closed lead stays on screen.
  const filterValues = CLOSED_LEAD_STATUSES.replace(/[()"]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  check('CLOSED_LEAD_STATUSES (the filter string) matches CLOSED_LEAD_STATUS_LIST',
    same(filterValues, CLOSED_LEAD_STATUS_LIST), `${CLOSED_LEAD_STATUSES} vs ${JSON.stringify(CLOSED_LEAD_STATUS_LIST)}`);

  // ---- 3. THE CHECK CONSTRAINT, against its migration --------------------------------------------
  const declared = constraintValues('hiring_status');
  check('the hiring_status check constraint was found in a migration', declared.length > 0,
    declared.length ? declared.join(', ') : 'NOT FOUND — the comparison below would pass against nothing');
  if (declared.length) {
    check('HIRING_STATUSES matches the constraint exactly', same(HIRING_STATUSES, declared),
      `code ${JSON.stringify(HIRING_STATUSES)} vs migration ${JSON.stringify(declared)}`);
  }

  // ---- 4. THE ONE-LETTER TRAP, asserted so it cannot silently converge ---------------------------
  // If a future edit "tidies" these into one vocabulary, every call site on one side starts failing at run
  // time only. So the difference itself is pinned, in both directions, by value rather than by spelling.
  check("'pursue' is a LEAD status and NOT a hiring status",
    isLeadStatus('pursue') && !isHiringStatus('pursue'), 'the lead_status enum has it; the check constraint does not');
  check("'pursued' is a HIRING status and NOT a lead status",
    isHiringStatus('pursued') && !isLeadStatus('pursued'), 'the check constraint has it; the enum does not');
  check('the two vocabularies are genuinely different lists', !same(LEAD_STATUSES, HIRING_STATUSES),
    'if they ever become equal, one side is wrong and this check must fail');
  if (live) {
    check("and the database agrees: 'pursued' is NOT a valid lead status", !live.includes('pursued'),
      'proved against the live enum, not against this file');
  }

  // ---- 5. NO CALL SITE KEEPS ITS OWN COPY any more ------------------------------------------------
  // The literal that started this: a hardcoded ['new','pursued','not_for_us'] validating the hiring route.
  const hiring = readFileSync('src/app/api/hiring/route.ts', 'utf8');
  const usesGuard = /isHiringStatus\(/.test(hiring);
  const hasLiteral = /\['new',\s*'pursued',\s*'not_for_us'\]/.test(hiring);
  // The detail names WHICH half failed. Reporting "uses isHiringStatus" on a failure — which an earlier
  // version did, because the import line matches even when the literal has come back — is a message that
  // does not explain its own failure, the exact defect fixed in today-probe's followupWhy the same night.
  check('the hiring route validates through the shared constant, not a literal list',
    usesGuard && !hasLiteral,
    usesGuard && !hasLiteral ? 'calls isHiringStatus() and keeps no copy of the list'
      : !usesGuard ? 'it does not call isHiringStatus() at all'
        : 'it calls isHiringStatus() but a hardcoded copy of the list is BACK in the file');

  console.log(`\nstatus vocabulary: ${fail ? `${fail} FAILED` : 'all checks passed'}`);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error(`status-vocabulary-check could not run: ${e?.message ?? e}`); process.exitCode = 1; });
