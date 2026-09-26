/**
 * Repair what the "too_big" classification failure and DOF's unread Workable board left behind. Report only without
 * --write.
 *
 *   npx tsx --env-file=.env.local scripts/fix-employer-and-board.ts [--write]
 *
 *   1  DOF's board is Workable (dof.workable.com): record it and clear the fingerprint, so the next crawl reads the
 *      published list with real titles, and the row titled "1924855" closes as no longer on the board.
 *   2  Every company whose evidence is a "could not be read: [ … too_big …" failure: a surviving type is labelled a
 *      guess from the name, and the company is queued for the careers-page classification again.
 *   3  Any other type with no recorded source that is exactly what the name detector gives today is labelled a name
 *      guess, with the detector's reason. A type the name does not give is left alone: where it came from cannot be
 *      shown, and a label would be a guess of its own.
 */
import { createClient } from '@supabase/supabase-js';
import { detectEmployerType } from '../src/lib/agency-detector';
import { COMPANY_STATE_LEFT, withCompanyState } from '../src/lib/workspace-state';
import { probeAdmin } from '../src/lib/test-data';

const write = process.argv.includes('--write');
const db = probeAdmin();
const s = (v: any) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

(async () => {
  const all: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('companies')
      // 0049 moved the override to workspace_company_state; employer_type_reason STAYED, because the
      // crawl writes it as a shared explanation of the detected type on 525 companies that have no
      // override at all. So one of these two comes from the embed and the other from the row.
      .select(`id, name, employer_type, employer_type_source, employer_type_reason, employer_type_evidence, ats_type, ats_slug, careers_url, careers_fingerprint, ${COMPANY_STATE_LEFT}`)
      .order('id').range(f, f + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break; all.push(...data.map(withCompanyState)); if (data.length < 1000) break;
  }
  // The `.or(…)` this replaced cannot be written as a filter any more: half of it is on another table
  // and PostgREST's or() has no reach across an embed. The same rule is applied in memory instead —
  // the override where there is one, else the detected type, which is what effectiveEmployerType does.
  const agencyNames = all
    .filter((c: any) => (c.employer_type_override ?? c.employer_type) === 'staffing_agency')
    .map((c: any) => c.name);

  // 1 — DOF
  const dof = all.find((c) => c.name === 'DOF');
  const dofPatch = dof && dof.ats_type !== 'workable' ? { ats_type: 'workable', ats_slug: 'dof', careers_fingerprint: null } : null;
  console.log(`1 DOF: ats ${dof?.ats_type ?? 'none'} → ${dofPatch ? 'workable/dof, fingerprint cleared' : 'already workable'}`);

  // 2 — the too_big failures
  const failedRead = all.filter((c) => /could not be read: \[/.test(s(c.employer_type_evidence)));
  const kept = failedRead.filter((c) => c.employer_type && c.employer_type !== 'unknown' && !c.employer_type_source && !c.employer_type_override);
  console.log(`2 classification failures: ${failedRead.length} · requeued for the careers-page read · ${kept.length} keep a type labelled as a name guess: ${kept.map((c) => `${c.name} (${c.employer_type})`).join(', ')}`);

  // 3 — other unlabelled types the name gives
  const unlabelled = all.filter((c) => c.employer_type && c.employer_type !== 'unknown' && !c.employer_type_source && !failedRead.includes(c));
  const fromName = unlabelled.map((c) => ({ c, det: detectEmployerType(c.name, agencyNames) })).filter((x) => x.det.employerType === x.c.employer_type);
  console.log(`3 other types with no source: ${unlabelled.length} · exactly what the name gives: ${fromName.length} · left unlabelled (origin cannot be shown): ${unlabelled.length - fromName.length}`);
  console.log(`  e.g. ${fromName.slice(0, 6).map((x) => `${x.c.name} → ${x.det.reason}`).join(' | ')}`);

  if (!write) { console.log('\nreport only — add --write to apply'); return; }

  const problems: string[] = [];
  const up = async (id: string, patch: Record<string, unknown>, label: string) => {
    const { error } = await db.from('companies').update(patch).eq('id', id);
    if (error) problems.push(`${label}: ${error.message}`);
  };
  if (dof && dofPatch) await up(dof.id, dofPatch, 'DOF');
  for (const c of failedRead) {
    await up(c.id, {
      employer_type_checked_at: null,
      ...(kept.includes(c) ? { employer_type_source: 'name', employer_type_reason: 'careers page could not be classified; the type shown is a guess from the name' } : {}),
    }, c.name);
  }
  for (const { c, det } of fromName) await up(c.id, { employer_type_source: 'name', employer_type_reason: det.reason }, c.name);
  console.log(`\nwritten · problems ${problems.length}${problems.length ? `:\n  ${problems.slice(0, 5).join('\n  ')}` : ''}`);
  process.exitCode = problems.length ? 1 : 0;
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
