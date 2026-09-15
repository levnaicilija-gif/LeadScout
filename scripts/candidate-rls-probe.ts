/**
 * Item 24: the candidate CRM's rows stay inside their workspace — read AND write — as signed-in users. SENSITIVE
 * PERSONAL DATA, so this is proven on rows that exist, not assumed from a policy's text.
 *
 *   npx tsx --env-file=.env.local scripts/candidate-rls-probe.ts
 *
 * scripts/rls-sweep.ts compares a signed-in user's reads with the service role's, table by table; it cannot judge a table
 * with no rows (candidate_placements had none when 0035 was applied) and it never tries a write. This does both, with two
 * throwaway accounts in their own test workspaces:
 *   - A sees their own candidate, its CV-sent row and its placement, and may record a placement for their own candidate;
 *   - B, in another workspace, reads none of A's candidate, CV-sent rows or placements;
 *   - B cannot record a placement in A's workspace, nor one in B's own workspace that points at A's candidate (0035's
 *     WITH CHECK), cannot change or delete A's placement, cannot log a CV sent for A's candidate, and cannot change A's
 *     candidate's stage.
 * Every row it made is removed afterwards with both accounts and workspaces; a leftover fails the run.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { markWorkspaceTest, removeProbe } from '../src/lib/test-data';
import { hasCandidateCrm } from '../src/lib/schema-features';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

async function account(tag: string) {
  const email = `candidate-rls-${tag}+${Date.now()}@rfbt-recruitment.com`;
  const password = `probe-${Date.now()}-${tag}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `Candidate RLS ${tag}`, agency: `Candidate RLS ${tag}` } });
  if (error) throw new Error(`could not create account ${tag}: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  const client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { error: signIn } = await client.auth.signInWithPassword({ email, password });
  if (signIn) throw new Error(`account ${tag} could not sign in: ${signIn.message}`);
  return { uid, workspace, client };
}

const rows = async (q: PromiseLike<{ data: any; error: any }>) => { const r = await q; return { n: Array.isArray(r.data) ? r.data.length : r.data ? 1 : 0, error: r.error?.message ?? null }; };

(async () => {
  if (!(await hasCandidateCrm(admin))) { console.log('0035 is not applied — nothing to check'); process.exit(1); }
  let A: Awaited<ReturnType<typeof account>> | null = null;
  let B: Awaited<ReturnType<typeof account>> | null = null;
  try {
    A = await account('a');
    B = await account('b');
    const { data: cand, error: cErr } = await admin.from('candidates').insert({ workspace_id: A.workspace, reference_code: `RLSPROBE${Date.now().toString().slice(-5).replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)])}-X-0001`, trade_code: 'X', full_name: 'RLS Probe Person', created_via: 'manual', created_by: A.uid, owner_id: A.uid, stage: 'placed', is_test: true }).select('id').single();
    if (cErr) throw new Error(`seeding failed: ${cErr.message}`);
    await admin.from('sends').insert({ candidate_id: cand!.id, sent_by: A.uid, client_name: 'Semco Maritime' });
    const { data: pl } = await admin.from('candidate_placements').insert({ workspace_id: A.workspace, candidate_id: cand!.id, client_name: 'AIBEL', placed_on: '2026-09-01', placed_by: A.uid }).select('id').single();

    console.log('The owner, A');
    const aCand = await rows(A.client.from('candidates').select('id').eq('id', cand!.id));
    const aSends = await rows(A.client.from('sends').select('id').eq('candidate_id', cand!.id));
    const aPl = await rows(A.client.from('candidate_placements').select('id').eq('candidate_id', cand!.id));
    check(aCand.n === 1 && aSends.n === 1 && aPl.n === 1, 'A reads their own candidate, CV-sent row and placement', JSON.stringify({ aCand, aSends, aPl }));
    const aInsert = await rows(A.client.from('candidate_placements').insert({ workspace_id: A.workspace, candidate_id: cand!.id, client_name: 'Semco Maritime', placed_on: '2026-09-10', placed_by: A.uid }).select('id'));
    check(aInsert.n === 1 && !aInsert.error, 'A may record a placement for their own candidate', JSON.stringify(aInsert));

    console.log('\nAnother workspace, B');
    const bCand = await rows(B.client.from('candidates').select('id').eq('id', cand!.id));
    const bSends = await rows(B.client.from('sends').select('id').eq('candidate_id', cand!.id));
    const bPl = await rows(B.client.from('candidate_placements').select('id').eq('candidate_id', cand!.id));
    const bAllPl = await rows(B.client.from('candidate_placements').select('id'));
    check(bCand.n === 0 && bSends.n === 0 && bPl.n === 0 && bAllPl.n === 0, "B reads none of A's candidate, CV-sent rows or placements", JSON.stringify({ bCand, bSends, bPl, bAllPl }));
    const intoA = await rows(B.client.from('candidate_placements').insert({ workspace_id: A.workspace, candidate_id: cand!.id, client_name: 'Forged', placed_on: '2026-09-11', placed_by: B.uid }).select('id'));
    check(intoA.n === 0 && !!intoA.error, "B cannot record a placement in A's workspace", JSON.stringify(intoA));
    const pointing = await rows(B.client.from('candidate_placements').insert({ workspace_id: B.workspace, candidate_id: cand!.id, client_name: 'Forged', placed_on: '2026-09-11', placed_by: B.uid }).select('id'));
    check(pointing.n === 0 && !!pointing.error, "B cannot record a placement in B's own workspace that points at A's candidate (the WITH CHECK)", JSON.stringify(pointing));
    await B.client.from('candidate_placements').update({ client_name: 'Changed by B', ended_on: '2026-09-12' }).eq('id', pl!.id);
    await B.client.from('candidate_placements').delete().eq('id', pl!.id);
    const { data: still } = await admin.from('candidate_placements').select('client_name, ended_on').eq('id', pl!.id).maybeSingle();
    check(still?.client_name === 'AIBEL' && still.ended_on === null, "B cannot change or delete A's placement", JSON.stringify(still));
    const sendForA = await rows(B.client.from('sends').insert({ candidate_id: cand!.id, sent_by: B.uid, client_name: 'Forged' }).select('id'));
    check(sendForA.n === 0 && !!sendForA.error, "B cannot log a CV sent for A's candidate", JSON.stringify(sendForA));
    await B.client.from('candidates').update({ stage: 'bench', stage_changed_by: B.uid }).eq('id', cand!.id);
    const { data: stage } = await admin.from('candidates').select('stage, stage_changed_by').eq('id', cand!.id).single();
    check(stage?.stage === 'placed' && stage.stage_changed_by === null, "B cannot change A's candidate's stage", JSON.stringify(stage));
  } catch (e: any) {
    failures++;
    console.log(`  FAIL  ${e?.message ?? e}`);
  } finally {
    for (const who of [A, B]) {
      if (!who) continue;
      const left = await removeProbe(admin, who.uid, who.workspace, null, { clearContent: true });
      if (left) { failures++; console.log(`  FAIL  cleanup — ${left}`); }
    }
    console.log('\nboth probe accounts, their workspaces and every seeded row removed');
  }
  console.log(failures === 0 ? 'candidate rls probe: all checks passed' : `candidate rls probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
