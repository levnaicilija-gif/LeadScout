/**
 * Run the employer-type detector over companies that have a careers board.
 *
 * They were created by careers discovery, which never ran it, so every one of them sat at
 * "unknown" — and the agency filter on Hiring now can only protect a recruiter where something
 * actually says "agency".
 *
 * An override always wins and is never touched: a person's decision is not the detector's to
 * revisit. Nothing else about the company changes.
 *
 *   npx tsx --env-file=.env.local scripts/classify-employers.ts           report only
 *   npx tsx --env-file=.env.local scripts/classify-employers.ts --write   apply
 */
import { createClient } from '@supabase/supabase-js';
import { detectEmployerType } from '../src/lib/agency-detector';
import { COMPANY_STATE_LEFT, withCompanyState } from '../src/lib/workspace-state';
import { probeAdmin } from '../src/lib/test-data';

const write = process.argv.includes('--write');
const db = probeAdmin();

(async () => {
  // 0049 moved the employer-type override to workspace_company_state, so the `.or(…)` that used to
  // express "overridden to agency, OR detected as one with no override" cannot be written as a filter
  // any more: half of it is on another table and PostgREST's or() grammar has no reach across an
  // embed. The rows are fetched with the state embed and the same rule is applied IN MEMORY —
  // effectiveEmployerType, which is exactly what the app uses. 5,893 companies, one pass, no ceiling.
  const { data: allCos } = await db.from('companies').select(`name, employer_type, ${COMPANY_STATE_LEFT}`);
  const agencyNames = (allCos ?? []).map(withCompanyState)
    .filter((c: any) => (c.employer_type_override ?? c.employer_type) === 'staffing_agency')
    .map((c: any) => c.name);
  console.log(`${agencyNames.length} companies are already known agencies\n`);

  const { data: boardRows } = await db.from('companies')
    .select(`id, name, employer_type, ${COMPANY_STATE_LEFT}`)
    .eq('careers_status', 'found');
  const withBoards = (boardRows ?? []).map(withCompanyState);

  const counts: Record<string, number> = {};
  const changes: { name: string; from: string; to: string; why: string }[] = [];
  let skipped = 0;

  for (const c of withBoards as any[]) {
    if (c.employer_type_override) { skipped++; continue; }   // a person has already decided
    const det = detectEmployerType(c.name, agencyNames);
    counts[det.employerType] = (counts[det.employerType] ?? 0) + 1;
    if (det.employerType === c.employer_type) continue;

    // Never trade a specific answer for "unknown". Worley, Saipem, Boskalis and eight others
    // were set to epc_contractor from the seed file's own description of each firm; the
    // detector reads a name and would hand all of that back, because "Worley" says nothing.
    // The detector fills gaps — it does not overwrite what is already known.
    if (det.employerType === 'unknown' && c.employer_type && c.employer_type !== 'unknown') {
      skipped++;
      continue;
    }
    changes.push({ name: c.name, from: c.employer_type ?? 'null', to: det.employerType, why: det.reason });
    if (write) await db.from('companies').update({ employer_type: det.employerType }).eq('id', c.id);
  }

  console.log(`${(withBoards ?? []).length} companies with a board · ${skipped} left alone because a person had set them\n`);
  console.log('what the detector says:', JSON.stringify(counts));
  console.log(`\n${changes.length} changed:`);
  for (const ch of changes.slice(0, 40)) console.log(`  ${ch.name.padEnd(34).slice(0, 34)} ${ch.from} → ${ch.to}   (${ch.why})`);
  if (changes.length > 40) console.log(`  … and ${changes.length - 40} more`);
  if (!write) console.log('\n(report only — pass --write to apply)');
})();
