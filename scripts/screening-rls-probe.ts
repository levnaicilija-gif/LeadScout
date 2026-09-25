/**
 * 0040: a screening call and its answers stay inside their workspace, as signed-in users.
 *
 *   npx tsx --env-file=.env.local scripts/screening-rls-probe.ts
 *
 * SENSITIVE PERSONAL DATA: a call holds what a named person said about their certificates, their
 * right to work and their money. So this is proven on rows that exist, not assumed from a policy's
 * text — the candidate-data rule in CLAUDE.md.
 *
 * screening_answers carries no workspace_id of its own: its policy reaches THROUGH screening_calls
 * in both USING and WITH CHECK, which no other policy in this codebase does. That is the shape most
 * likely to be wrong, and the insert-against-another-workspace's-call case is the one that matters:
 * a WITH CHECK that only looked at the row being written would let anybody append an answer to
 * anybody's call.
 *
 * Two accounts, two workspaces:
 *   - A starts a call on their own candidate and answers a question;
 *   - B reads no call and no answer of A's;
 *   - B cannot start a call in A's workspace, nor one in B's own workspace pointing at A's candidate;
 *   - B cannot append an answer to A's call, nor change or delete A's answer.
 * Everything it makes is removed afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const stamp = Date.now();

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

async function account(tag: string) {
  const email = `screening-rls-${tag}+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-${tag}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `Screening RLS ${tag}`, agency: `Screening RLS ${tag}` } });
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

const rows = async (q: PromiseLike<{ data: any; error: any }>) => {
  const r = await q;
  return { n: Array.isArray(r.data) ? r.data.length : r.data ? 1 : 0, error: r.error?.message ?? null };
};

const code = (tag: string) => `SCREEN${stamp.toString().slice(-5).replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)])}-X-${tag}`;

(async () => {
  const { error: notThere } = await admin.from('screening_calls').select('id').limit(1);
  if (notThere) { console.log(`0040 is not applied — nothing to check (${notThere.code} ${notThere.message})`); process.exit(1); }

  let A: Awaited<ReturnType<typeof account>> | null = null;
  let B: Awaited<ReturnType<typeof account>> | null = null;
  try {
    A = await account('a');
    B = await account('b');

    const person = async (ws: string, uid: string, tag: string) => {
      const { data, error } = await admin.from('candidates').insert({
        workspace_id: ws, reference_code: code(tag), trade_code: 'X', full_name: `Screening Probe ${tag}`,
        created_via: 'manual', created_by: uid, is_test: true,
      }).select('id').single();
      if (error) throw new Error(`seeding candidate ${tag}: ${error.message}`);
      return data.id as string;
    };
    const candA = await person(A.workspace, A.uid, '0001');
    const candB = await person(B.workspace, B.uid, '0002');

    console.log("A's own call");
    const started = await rows(A.client.from('screening_calls').insert({
      workspace_id: A.workspace, candidate_id: candA, jd_version: 3, started_by: A.uid,
    }).select('id'));
    check(started.n === 1 && !started.error, 'A starts a call on their own candidate', JSON.stringify(started));
    const { data: call } = await admin.from('screening_calls').select('id').eq('candidate_id', candA).maybeSingle();

    const asked = await rows(A.client.from('screening_answers').insert({
      call_id: call!.id, position: 0, question: 'Which processes are on your ISO 9606?',
      good_answer: 'Names 135/136 from memory.', kind: 'certificate', subject: 'ISO 9606',
    }).select('id'));
    check(asked.n === 1 && !asked.error, 'and writes a question into it', JSON.stringify(asked));

    const answered = await rows(A.client.from('screening_answers').update({
      answer: '135 and 136, expires next March.', verdict: 'confirmed', answered_by: A.uid, answered_at: new Date().toISOString(),
    }).eq('call_id', call!.id).eq('position', 0).select('id'));
    check(answered.n === 1 && !answered.error, 'and records what was said, with their own verdict', JSON.stringify(answered));

    console.log('\nAnother workspace, B');
    const bCalls = await rows(B.client.from('screening_calls').select('id').eq('id', call!.id));
    const bAll = await rows(B.client.from('screening_calls').select('id'));
    const bAnswers = await rows(B.client.from('screening_answers').select('id').eq('call_id', call!.id));
    const bAnyAnswer = await rows(B.client.from('screening_answers').select('id'));
    check(bCalls.n === 0 && bAll.n === 0 && bAnswers.n === 0 && bAnyAnswer.n === 0,
      "B reads none of A's calls and none of A's answers", JSON.stringify({ bCalls, bAll, bAnswers, bAnyAnswer }));

    const intoA = await rows(B.client.from('screening_calls').insert({
      workspace_id: A.workspace, candidate_id: candA, started_by: B.uid,
    }).select('id'));
    check(intoA.n === 0 && !!intoA.error, "B cannot start a call in A's workspace", JSON.stringify(intoA));

    // 0040's WITH CHECK tested only workspace_id, which B satisfies with their OWN id — so this
    // passed until 0041 added the "every row it points at must be mine too" test (2026-09-17).
    const pointing = await rows(B.client.from('screening_calls').insert({
      workspace_id: B.workspace, candidate_id: candA, started_by: B.uid,
    }).select('id'));
    check(pointing.n === 0 && !!pointing.error, "B cannot start one in their own workspace pointing at A's candidate", JSON.stringify(pointing));

    // The same hole, by the other two references a call can carry.
    const { data: leadA } = await admin.from('leads').insert({
      workspace_id: A.workspace, kind: 'won_work', project_name: 'Screening probe lead', is_test: true,
    }).select('id').single();
    const pointingLead = await rows(B.client.from('screening_calls').insert({
      workspace_id: B.workspace, candidate_id: candB, lead_id: leadA!.id, started_by: B.uid,
    }).select('id'));
    check(pointingLead.n === 0 && !!pointingLead.error, "nor one pointing at A's lead", JSON.stringify(pointingLead));

    // The one that matters: the answers policy reaches through the call to find the workspace.
    const appended = await rows(B.client.from('screening_answers').insert({
      call_id: call!.id, position: 1, question: 'Forged question', kind: 'open',
    }).select('id'));
    check(appended.n === 0 && !!appended.error, "B cannot append an answer to A's call (the WITH CHECK reaches through the call)", JSON.stringify(appended));

    await B.client.from('screening_answers').update({ answer: 'Changed by B', verdict: 'not_confirmed' }).eq('call_id', call!.id).eq('position', 0);
    await B.client.from('screening_answers').delete().eq('call_id', call!.id).eq('position', 0);
    const { data: still } = await admin.from('screening_answers').select('answer, verdict').eq('call_id', call!.id).eq('position', 0).maybeSingle();
    check(still?.answer === '135 and 136, expires next March.' && still?.verdict === 'confirmed',
      "B cannot change or delete A's answer", JSON.stringify(still));

    await B.client.from('screening_calls').update({ needs_rescore: true, rescore_reason: 'forged' }).eq('id', call!.id);
    const { data: callStill } = await admin.from('screening_calls').select('needs_rescore, rescore_reason').eq('id', call!.id).single();
    check(callStill?.needs_rescore === false && !callStill?.rescore_reason, "nor mark A's call for a re-score", JSON.stringify(callStill));

    console.log('\nB in their own workspace');
    const own = await rows(B.client.from('screening_calls').insert({
      workspace_id: B.workspace, candidate_id: candB, started_by: B.uid,
    }).select('id'));
    check(own.n === 1 && !own.error, 'B may start a call on their own candidate — the boundary is the workspace, not the feature', JSON.stringify(own));
  } finally {
    const left: string[] = [];
    for (const a of [B, A]) {
      if (!a) continue;
      // screening_calls cascade from the candidate, and answers from the call; clearTestWorkspace
      // removes candidates, so the calls go with them. Anything orphaned is named here.
      // In foreign-key order, and every table this probe seeds: a lead was added for the lead_id
      // variant and not cleared, which stranded a workspace on leads_workspace_id_fkey (2026-09-17).
      // clearTestWorkspace covers candidates and documents, not leads or companies.
      for (const t of ['screening_calls', 'scores', 'leads'] as const) {
        const { error } = await admin.from(t).delete().eq(t === 'scores' ? 'workspace_id' : 'workspace_id', a.workspace);
        if (error && !/column .* does not exist/i.test(error.message)) left.push(`${t} of ${a.workspace}: ${error.message}`);
      }
      const notGone = await removeProbe(admin, a.uid, a.workspace, null, { clearContent: true });
      if (notGone) left.push(notGone);
    }
    console.log(left.length ? `\ncleanup left something behind: ${left.join('; ')}` : '\nboth probe accounts and both workspaces were removed');
    if (left.length) failures++;
  }

  console.log(failures ? `\nscreening RLS probe: ${failures} FAILED` : '\nscreening RLS probe: all checks passed');
  process.exit(failures ? 1 : 0);
})();
