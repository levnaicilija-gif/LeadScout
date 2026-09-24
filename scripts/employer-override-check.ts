/**
 * A recruiter's employer-type override survives the classifier re-reading the company.
 *
 *   npx tsx --env-file=.env.local scripts/employer-override-check.ts
 *
 * WHY THIS EXISTS. api/jobs/classify-employers used to skip any company a person had ruled on —
 * `.is('employer_type_override', null)` — because the override and the detected type shared a row
 * and re-classifying could overwrite somebody's judgement. Item 20 moved the override into
 * workspace_company_state, so that filter was removed: the classifier can no longer reach the
 * override, whatever it writes.
 *
 * THAT CLAIM IS THE WHOLE JUSTIFICATION FOR DELETING A GUARD, so it is asserted rather than
 * believed. Removing a protection because "the schema handles it now" is exactly the kind of
 * reasoning that is right until it quietly isn't — a later patch that writes an override from the
 * crawl, or a read that stops preferring it, would put the original bug back with nothing to catch
 * it, and the symptom would be a recruiter's correction silently reverting.
 *
 * THE MUTATION IS THE REAL CLASSIFIER WRITE, not a made-up update: verdictPatch is imported and
 * given a verdict that DISAGREES with the override, and the patch it returns is applied exactly as
 * the route applies it. So this fails if verdictPatch ever starts writing an override, and it fails
 * if the read stops preferring one.
 *
 * Everything is made in a throwaway workspace and removed; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { markTest, markWorkspaceTest } from '../src/lib/test-data';
import { verdictPatch } from '../src/lib/employer-verdict';
import { effectiveEmployerType } from '../src/lib/agency-detector';
import { COMPANY_STATE_LEFT, withCompanyState } from '../src/lib/workspace-state';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const fail: string[] = [];
const ok: string[] = [];
function check(name: string, pass: boolean, detail: string) {
  (pass ? ok : fail).push(`${name} — ${detail}`);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}

async function main() {
  if (!url || !key) { console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'); process.exitCode = 1; return; }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { error: tableErr } = await db.from('workspace_company_state').select('company_id').limit(1);
  if (tableErr) { console.error(`workspace_company_state is not readable (${tableErr.code ?? '?'} ${tableErr.message}) — apply 0047 first`); process.exitCode = 2; return; }

  const slug = `override-check-${Date.now().toString(36)}`;
  const { data: ws, error: wsErr } = await db.from('workspaces').insert({ name: 'Override Check Workspace', slug }).select('id').single();
  if (wsErr || !ws) { console.error(`could not create the probe workspace: ${wsErr?.message}`); process.exitCode = 1; return; }
  await markWorkspaceTest(db, ws.id);

  try {
    // A company the crawl believes is an end client.
    const { data: co, error: coErr } = await db.from('companies')
      .insert({ workspace_id: ws.id, name: 'Override Check Co', employer_type: 'end_client', employer_type_source: 'careers_page' })
      .select('id, name, employer_type, employer_type_source').single();
    if (coErr || !co) throw new Error(`could not create the probe company: ${coErr?.message}`);
    await markTest(db, 'companies', [co.id]);

    // A recruiter disagrees: it is an agency. Written where api/company/employer-type now writes it.
    const { error: ovErr } = await db.from('workspace_company_state')
      .upsert({ workspace_id: ws.id, company_id: co.id, employer_type_override: 'staffing_agency' }, { onConflict: 'workspace_id,company_id' });
    if (ovErr) throw new Error(`could not write the override: ${ovErr.message}`);

    const readBack = async () => {
      const { data } = await db.from('companies').select(`id, name, employer_type, employer_type_source, ${COMPANY_STATE_LEFT}`).eq('id', co.id).single();
      return withCompanyState(data as any);
    };

    const before = await readBack();
    check('the override wins before the classifier runs', effectiveEmployerType(before as any) === 'staffing_agency',
      `detected "${before.employer_type}", override "${before.employer_type_override}", effective "${effectiveEmployerType(before as any)}"`);

    // ---- THE MUTATION: the classifier re-reads it and disagrees with the recruiter ---------------
    // verdictPatch is the route's own function, applied the way the route applies it. A verdict of
    // epc_contractor contradicts BOTH the stored type and the override, so nothing here can pass by
    // the two happening to agree.
    const { patch, changedTo } = verdictPatch(co as any, { employer_type: 'epc_contractor', evidence: 'the careers page describes EPC delivery' });
    const { error: upErr } = await db.from('companies').update(patch).eq('id', co.id);
    if (upErr) throw new Error(`the classifier write failed: ${upErr.message}`);

    const after = await readBack();
    check('the classifier really did change the detected type', after.employer_type === 'epc_contractor' && changedTo === 'epc_contractor',
      `"${before.employer_type}" -> "${after.employer_type}" — the mutation landed, so the next check is not vacuous`);
    check('THE OVERRIDE IS UNTOUCHED', after.employer_type_override === 'staffing_agency',
      `the recruiter's "staffing_agency" survived a write that set the detected type to "${after.employer_type}"`);
    check('and the override still WINS on read', effectiveEmployerType(after as any) === 'staffing_agency',
      `effective type is "${effectiveEmployerType(after as any)}" — what the recruiter decided, not what the crawl concluded`);

    // The patch itself must not name an override, which is the property that makes the deleted
    // filter unnecessary. Asserted on the PATCH rather than on the row, so a future verdictPatch
    // that started writing one fails here even if the row happened to look right.
    check('verdictPatch names no override column', !Object.keys(patch).some((k) => k.includes('override')),
      `it writes ${Object.keys(patch).join(', ')} — none of which is an override`);
  } finally {
    const leftovers: string[] = [];
    for (const t of ['workspace_company_state', 'companies'] as const) {
      const { error } = await db.from(t).delete().eq('workspace_id', ws.id);
      if (error) leftovers.push(`${t}: ${error.message}`);
    }
    const { error: wsDel } = await db.from('workspaces').delete().eq('id', ws.id);
    if (wsDel) leftovers.push(`workspaces: ${wsDel.message}`);
    const { data: still } = await db.from('workspaces').select('id').eq('id', ws.id).maybeSingle();
    check('the probe cleans up after itself', !leftovers.length && !still,
      leftovers.length ? leftovers.join('; ') : 'the throwaway workspace and everything in it are gone');
  }

  console.log(`\n${ok.length} passed, ${fail.length} failed`);
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
