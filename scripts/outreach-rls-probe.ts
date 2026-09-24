/**
 * 0046: outreach, documents and verifications stay inside their workspace, as signed-in users.
 *
 *   npx tsx --env-file=.env.local scripts/outreach-rls-probe.ts
 *
 * THE THREE THE DESIGN ASKED FOR AND NOBODY HAD. Item 20's step-1 probe names "two throwaway
 * workspaces try to read each other's outreach, candidates, documents, verifications". Candidates
 * got one (candidate-rls-probe); these three never did, and rls-sweep — which compares row counts —
 * CANNOT TEST A WRITE. A policy that reads correctly and writes wrongly is exactly what 0041 found
 * on screening_calls, so counting rows would have missed it.
 *
 * AND ONE REGRESSION TEST FOR A LIVE BUG. Until 0046 the policy was "lead_id in (select id from
 * leads where workspace_id = my_workspace())", while api/hiring writes an approach drafted from
 * postings with a company_id and NO lead_id — the route's own comment says so. NULL is never `in`
 * anything, so those rows matched no policy: written by the service role, then invisible to the
 * people who wrote them, and /api/outreach answered 404 on a draft it had just created. A company-
 * only draft being READABLE BY ITS OWN WORKSPACE is asserted below, because that is the bug.
 *
 * Two accounts, two workspaces:
 *   - A has a lead-backed draft, a COMPANY-ONLY draft, a document and a verification;
 *   - A reads all of its own, including the company-only draft;
 *   - B reads none of them;
 *   - B cannot file a draft in A's workspace, nor one in B's own pointing at A's lead (the 0041
 *     rule: a WITH CHECK that only looks at the row being written is satisfied by putting your own
 *     id on it);
 *   - B cannot change or delete A's draft, document or verification.
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
  const email = `outreach-rls-${tag}+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-${tag}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `Outreach RLS ${tag}`, agency: `Outreach RLS ${tag}` } });
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

const seen = async (q: PromiseLike<{ data: any; error: any }>) => {
  const r = await q;
  return { n: Array.isArray(r.data) ? r.data.length : r.data ? 1 : 0, error: r.error?.message ?? null };
};

(async () => {
  // Exit 2 = not judged, the idiom priority-window and industry-follow already use.
  const { error: noColumn } = await admin.from('outreach').select('workspace_id').limit(1);
  // process.exitCode, never process.exit(): on Windows the latter trips a UV_HANDLE_CLOSING
  // assertion and leaves 127, which the gate reads as a failure rather than "not judged".
  if (noColumn) { console.log(`0046 is not applied — outreach has no workspace_id yet, so its new policy cannot be judged (${noColumn.message})`); process.exitCode = 2; return; }

  let A: Awaited<ReturnType<typeof account>> | null = null;
  let B: Awaited<ReturnType<typeof account>> | null = null;
  try {
    A = await account('a');
    B = await account('b');

    // --- A's data, seeded with the service role so the writes themselves are not what is tested.
    const co = (await admin.from('companies').insert({ workspace_id: A.workspace, name: `Outreach RLS Co ${stamp}`, country: 'DK', is_test: true }).select('id').single()).data!;
    const lead = (await admin.from('leads').insert({ workspace_id: A.workspace, company_id: co.id, kind: 'won_work', status: 'new', country: 'DK', project_name: `Outreach RLS project ${stamp}`, is_test: true }).select('id').single()).data!;
    const cand = (await admin.from('candidates').insert({ workspace_id: A.workspace, full_name: `Outreach RLS Person ${stamp}`, reference_code: `RFBT-O-${String(stamp).slice(-6)}` }).select('id').single()).data!;
    const doc = (await admin.from('documents').insert({ workspace_id: A.workspace, candidate_id: cand.id, type: 'certificate', cert_body: 'cswip', storage_path: `test/${stamp}/o.pdf`, is_test: true }).select('id').single()).data!;
    const ver = (await admin.from('verifications').insert({ document_id: doc.id, method: 'browser_lookup', result: 'valid', state: 'verified_register', checked_at: new Date().toISOString() }).select('id').single()).data!;
    const withLead = (await admin.from('outreach').insert({ workspace_id: A.workspace, lead_id: lead.id, channel: 'email', subject: `lead draft ${stamp}`, body: 'x', status: 'draft', is_test: true }).select('id').single()).data!;
    const companyOnly = (await admin.from('outreach').insert({ workspace_id: A.workspace, company_id: co.id, channel: 'email', subject: `company draft ${stamp}`, body: 'x', status: 'draft', is_test: true }).select('id').single()).data!;

    console.log('--- A reads its own, including the draft that used to be invisible ---');
    check((await seen(A.client.from('outreach').select('id').eq('id', withLead.id))).n === 1, 'A reads its lead-backed draft');
    const own = await seen(A.client.from('outreach').select('id').eq('id', companyOnly.id));
    check(own.n === 1, 'A reads its COMPANY-ONLY draft — the one that matched no policy before 0046 and made /api/outreach 404 on its own work', own.error ?? `${own.n} row(s)`);
    check((await seen(A.client.from('documents').select('id').eq('id', doc.id))).n === 1, 'A reads its own document');
    check((await seen(A.client.from('verifications').select('id').eq('id', ver.id))).n === 1, 'A reads its own verification');

    console.log('\n--- B reads none of it ---');
    check((await seen(B.client.from('outreach').select('id').eq('id', withLead.id))).n === 0, 'B reads none of A\'s lead-backed draft');
    check((await seen(B.client.from('outreach').select('id').eq('id', companyOnly.id))).n === 0, 'nor the company-only one — it is visible to its own workspace, not to everyone');
    check((await seen(B.client.from('documents').select('id').eq('id', doc.id))).n === 0, 'B reads none of A\'s documents');
    check((await seen(B.client.from('verifications').select('id').eq('id', ver.id))).n === 0, 'B reads none of A\'s verifications');

    console.log('\n--- B cannot write into A\'s workspace, nor point at A\'s rows (the 0041 rule) ---');
    const intoA = await B.client.from('outreach').insert({ workspace_id: A.workspace, lead_id: lead.id, channel: 'email', subject: 'no', body: 'x', status: 'draft' }).select('id');
    check(!!intoA.error || (intoA.data ?? []).length === 0, 'B cannot file a draft in A\'s workspace', intoA.error?.message?.slice(0, 60) ?? `${(intoA.data ?? []).length} row(s) written`);
    const ownButPointing = await B.client.from('outreach').insert({ workspace_id: B.workspace, lead_id: lead.id, channel: 'email', subject: 'no', body: 'x', status: 'draft' }).select('id');
    check(!!ownButPointing.error || (ownButPointing.data ?? []).length === 0,
      'nor one in its OWN workspace pointing at A\'s lead — the WITH CHECK looks at the parent, not only at the row',
      ownButPointing.error?.message?.slice(0, 60) ?? `${(ownButPointing.data ?? []).length} row(s) written`);
    const pointingAtCompany = await B.client.from('outreach').insert({ workspace_id: B.workspace, company_id: co.id, channel: 'email', subject: 'no', body: 'x', status: 'draft' }).select('id');
    check(!!pointingAtCompany.error || (pointingAtCompany.data ?? []).length === 0,
      'nor at A\'s company', pointingAtCompany.error?.message?.slice(0, 60) ?? `${(pointingAtCompany.data ?? []).length} row(s) written`);

    console.log('\n--- B cannot change or delete what is A\'s ---');
    await B.client.from('outreach').update({ subject: 'changed by B' }).eq('id', companyOnly.id);
    const after = (await admin.from('outreach').select('subject').eq('id', companyOnly.id).maybeSingle()).data;
    check(after?.subject === `company draft ${stamp}`, 'A\'s draft is unchanged after B tried to rewrite it', String(after?.subject));
    await B.client.from('outreach').delete().eq('id', withLead.id);
    check((await admin.from('outreach').select('id', { count: 'exact', head: true }).eq('id', withLead.id)).count === 1, 'and still there after B tried to delete it');
    await B.client.from('documents').delete().eq('id', doc.id);
    check((await admin.from('documents').select('id', { count: 'exact', head: true }).eq('id', doc.id)).count === 1, 'A\'s document survives B\'s delete');
    await B.client.from('verifications').delete().eq('id', ver.id);
    check((await admin.from('verifications').select('id', { count: 'exact', head: true }).eq('id', ver.id)).count === 1, 'and so does A\'s verification');

    console.log('\n--- A can still do its own work ---');
    const mine = await A.client.from('outreach').insert({ workspace_id: A.workspace, company_id: co.id, channel: 'email', subject: `a writes ${stamp}`, body: 'x', status: 'draft' }).select('id');
    check(!mine.error && (mine.data ?? []).length === 1, 'A files a company-only draft in its own workspace', mine.error?.message?.slice(0, 70) ?? 'written');

    /**
     * THE MUTATION, run inside the probe rather than described in a commit message.
     *
     * Everything above could in principle pass because the read is simply always true — a policy
     * that filters nothing reads exactly like a policy that filters correctly, as long as you only
     * ever look at rows you own. So the company-only draft is MOVED to B's workspace with the
     * service role and A is asked for it again. If the read is genuinely gated, A loses it; if the
     * assertion was vacuous, A keeps it and this fails.
     *
     * It mutates DATA, not the policy, because altering live RLS to test it is not a trade worth
     * making — and the row is moved straight back.
     */
    console.log('\n--- the mutation: is that read actually gated, or merely always true? ---');
    const { error: moveErr } = await admin.from('outreach').update({ workspace_id: B.workspace }).eq('id', companyOnly.id);
    check(!moveErr, 'the draft can be moved to B with the service role', moveErr?.message ?? 'moved');
    const afterMove = await seen(A.client.from('outreach').select('id').eq('id', companyOnly.id));
    check(afterMove.n === 0, 'A can no longer read it — so the earlier read was the POLICY answering, not an unfiltered table', `${afterMove.n} row(s)`);
    const bNow = await seen(B.client.from('outreach').select('id').eq('id', companyOnly.id));
    check(bNow.n === 1, 'and B can, because it is B\'s row now — the boundary moves with the data', `${bNow.n} row(s)`);
    await admin.from('outreach').update({ workspace_id: A.workspace }).eq('id', companyOnly.id);
    check((await seen(A.client.from('outreach').select('id').eq('id', companyOnly.id))).n === 1, 'moved back, A reads it again');
  } finally {
    const problems: string[] = [];
    for (const w of [A?.workspace, B?.workspace].filter(Boolean) as string[]) {
      const { data: cands } = await admin.from('candidates').select('id').eq('workspace_id', w);
      for (const c of cands ?? []) {
        const { data: docs } = await admin.from('documents').select('id').eq('candidate_id', c.id);
        for (const d of docs ?? []) await admin.from('verifications').delete().eq('document_id', d.id);
        await admin.from('documents').delete().eq('candidate_id', c.id);
      }
      for (const t of ['outreach', 'documents', 'candidates', 'job_posts', 'leads', 'companies'] as const) {
        const { error } = await admin.from(t).delete().eq('workspace_id', w);
        if (error) problems.push(`${t}: ${error.message}`);
      }
    }
    for (const acct of [A, B]) {
      if (!acct) continue;
      const left = await removeProbe(admin, acct.uid, acct.workspace, null, { clearContent: true });
      if (left) problems.push(left);
    }
    for (const p of problems) console.log(`  CLEANUP PROBLEM: ${p}`);
    failures += problems.length;
    if (!problems.length) console.log('\n  both probe accounts, their workspaces and everything seeded were removed');
  }

  console.log(failures ? `\noutreach rls probe: ${failures} FAILED` : '\noutreach rls probe: all checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(`\noutreach rls probe: ${e?.message ?? e}`); process.exitCode = 1; });
