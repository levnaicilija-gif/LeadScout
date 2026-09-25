/**
 * 0051: a workspace records state against a lead it can SEE, and against nothing else.
 *
 *   npx tsx --env-file=.env.local scripts/state-write-visibility-probe.ts
 *
 * WHAT 0051 CHANGED, and why this probe is deliberately narrow. 0047's WITH CHECK on both state tables
 * keyed on OWNERSHIP — `lead_id in (select id from leads where workspace_id = my_workspace())` — which
 * becomes a lock the moment leads are shared: every workspace but the crawl's own would read a shared
 * lead and be unable to mark it. 0051 keys it on VISIBILITY instead, `lead_id in (select id from leads)`,
 * because a subquery inside a policy is itself subject to the referenced table's RLS.
 *
 * TODAY THE TWO ARE THE SAME SET, so this probe CANNOT prove the semantics differ — `leads` is still
 * `workspace_id = my_workspace()`, so "leads I can see" is exactly "leads I own". Saying that plainly
 * matters: an assertion that cannot fail is worth nothing, and three checks in this codebase have
 * already been caught passing vacuously. The entitlement behaviour gets its own probe at 3b/3c, where
 * cross-workspace visibility becomes real for the first time.
 *
 * IT ALSO CANNOT TELL WHICH POLICY IS LIVE, for the same reason, so it passing does not mean 0051 was
 * applied — it passed twelve for twelve against 0047 before 0051 was written. 0051's own DO block is the
 * only thing that confirms it landed: it asserts the WITH CHECK still references the parent AND no
 * longer carries `FROM leads WHERE`, which is what distinguishes the two renderings. This probe's job is
 * the opposite one — proving the safety properties are the same afterwards as before.
 *
 * WHAT IT DOES PROVE, all of which must hold before 3c may be attempted:
 *   1. RLS on `leads` is genuinely ON — B reads NONE of A's leads. Everything below rests on this, and
 *      the whole design rests on it: if RLS were off, `(select id from leads)` would return the world
 *      and 0051 would have opened the 0041 hole rather than preserved it.
 *   2. A can record state against its OWN lead, as the signed-in user — api/lead and api/outreach both
 *      write state that way, so the WITH CHECK is live on those paths.
 *   3. B CANNOT record state against A's lead, EVEN putting its own workspace id on the row. That is
 *      the 0041 property, and it is the one thing 0051 must not have loosened.
 *   4. B cannot write a row carrying A's workspace id either — the other half of 0041.
 *   5. The refusals come from the POLICY, not from something incidental: the same writes SUCCEED for
 *      the service role, which bypasses RLS. Without this, a probe that had simply got the ids wrong
 *      would report a pass.
 *   6. The same four properties for workspace_company_state.
 *
 * Everything it makes is removed afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { markTest, markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const fail: string[] = [];
const ok: string[] = [];
function check(name: string, pass: boolean, detail: string) {
  (pass ? ok : fail).push(`${name} — ${detail}`);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}

const admin = createClient(url, key, { auth: { persistSession: false } });

/** A throwaway account with its own workspace, and a client signed in AS that account. */
async function account(label: string, stamp: number) {
  const email = `state-visibility-${label}+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `State Visibility ${label}`, agency: `State Visibility ${label}` } });
  if (error) throw new Error(`could not create account ${label}: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  const client = createClient(url, anon, { auth: { persistSession: false } });
  const { error: signIn } = await client.auth.signInWithPassword({ email, password });
  if (signIn) throw new Error(`could not sign in as ${label}: ${signIn.message}`);
  return { uid, workspace, client };
}

async function main() {
  if (!url || !anon || !key) { console.error('NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required'); process.exitCode = 1; return; }

  // Not applied yet is "not judged", not a failure — the idiom 0046 and 0048 already use in this gate.
  const { data: pol } = await admin.from('workspace_lead_state').select('lead_id').limit(1);
  if (pol === null) { console.error('workspace_lead_state is not readable — apply 0047 first'); process.exitCode = 2; return; }

  const stamp = Date.now();
  let A: Awaited<ReturnType<typeof account>> | null = null;
  let B: Awaited<ReturnType<typeof account>> | null = null;

  try {
    A = await account('a', stamp);
    B = await account('b', stamp);

    const { data: co } = await admin.from('companies').insert({ workspace_id: A.workspace, name: `State Visibility Co ${stamp}` }).select('id').single();
    await markTest(admin, 'companies', [co!.id]);
    const { data: lead } = await admin.from('leads')
      .insert({ workspace_id: A.workspace, company_id: co!.id, kind: 'won_work', project_name: `State Visibility Lead ${stamp}` })
      .select('id').single();
    await markTest(admin, 'leads', [lead!.id]);

    // ---- 1. RLS on leads is real. EVERYTHING below rests on this -------------------------------
    const { data: bSees, error: bReadErr } = await B.client.from('leads').select('id').eq('id', lead!.id);
    check('RLS on leads is ON — B reads none of A\'s leads', !bReadErr && (bSees ?? []).length === 0,
      bReadErr ? `${bReadErr.code} ${bReadErr.message}` : `B sees ${(bSees ?? []).length} of A's lead — if this were 1, 0051 would have OPENED the 0041 hole, not preserved it`);
    const { data: aSees } = await A.client.from('leads').select('id').eq('id', lead!.id);
    check('and A does read its own lead', (aSees ?? []).length === 1, `A sees ${(aSees ?? []).length}`);

    // ---- 2. A records state against its own lead, as the signed-in user -------------------------
    // 0048's trigger already made the row, so this is the UPDATE path api/lead takes.
    const { error: aWrite } = await A.client.from('workspace_lead_state')
      .update({ status: 'pursue' }).eq('workspace_id', A.workspace).eq('lead_id', lead!.id);
    check('A can record state against its own lead', !aWrite,
      aWrite ? `REFUSED: ${aWrite.code} ${aWrite.message}` : 'status set to pursue as the signed-in user — the path api/lead and api/outreach take');
    const { data: back } = await admin.from('workspace_lead_state').select('status').eq('lead_id', lead!.id).maybeSingle();
    check('and it really landed', back?.status === 'pursue', `the row reads ${JSON.stringify(back?.status)}`);

    // ---- 3. THE 0041 PROPERTY: B cannot write state against A's lead ----------------------------
    // With B's OWN workspace id on the row, which is exactly the shape 0041 found: a WITH CHECK that
    // tests only the row being written is satisfied by this.
    const { error: bInsert } = await B.client.from('workspace_lead_state')
      .insert({ workspace_id: B.workspace, lead_id: lead!.id, status: 'pursue' });
    check('B CANNOT record state against a lead it cannot see', !!bInsert,
      bInsert ? `refused (${bInsert.code}) — the 0041 property survives 0051` : 'ACCEPTED — 0051 opened the hole it was meant to preserve');

    // ---- 4. …nor under A's workspace id ---------------------------------------------------------
    const { error: bAsA } = await B.client.from('workspace_lead_state')
      .insert({ workspace_id: A.workspace, lead_id: lead!.id, status: 'contacted' });
    check('B cannot write a row carrying A\'s workspace id', !!bAsA,
      bAsA ? `refused (${bAsA.code})` : 'ACCEPTED — B can file activity as A');

    // ---- 5. The refusals are the POLICY, not a wrong id ----------------------------------------
    // The identical insert, as the service role, must SUCCEED. Without this a probe whose lead id was
    // simply wrong would report two clean passes and prove nothing.
    const { error: svc } = await admin.from('workspace_lead_state')
      .insert({ workspace_id: B.workspace, lead_id: lead!.id, status: 'pursue' });
    check('the same write SUCCEEDS for the service role', !svc,
      svc ? `also refused (${svc.code} ${svc.message}) — so the refusals above may not be the policy at all` : 'so what refused B was RLS, not a bad id or a constraint');
    if (!svc) await admin.from('workspace_lead_state').delete().eq('workspace_id', B.workspace).eq('lead_id', lead!.id);

    // ---- 6. The company side, same four properties ---------------------------------------------
    const { error: aCoWrite } = await A.client.from('workspace_company_state')
      .insert({ workspace_id: A.workspace, company_id: co!.id, hiring_status: 'pursued' });
    check('A can record state against its own company', !aCoWrite,
      aCoWrite ? `REFUSED: ${aCoWrite.code} ${aCoWrite.message}` : 'hiring_status set as the signed-in user');

    const { error: bCoWrite } = await B.client.from('workspace_company_state')
      .insert({ workspace_id: B.workspace, company_id: co!.id, hiring_status: 'pursued' });
    check('B CANNOT record state against a company it cannot see', !!bCoWrite,
      bCoWrite ? `refused (${bCoWrite.code})` : 'ACCEPTED — the company half of the 0041 hole is open');

    const { error: bCoAsA } = await B.client.from('workspace_company_state')
      .insert({ workspace_id: A.workspace, company_id: co!.id, hiring_status: 'not_for_us' });
    check('B cannot write a company row carrying A\'s workspace id', !!bCoAsA,
      bCoAsA ? `refused (${bCoAsA.code})` : 'ACCEPTED');

    // ---- and B reads none of A's state, which is the boundary the whole item exists for ---------
    const { data: bReadsState } = await B.client.from('workspace_lead_state').select('lead_id').eq('lead_id', lead!.id);
    check('B reads none of A\'s lead state', (bReadsState ?? []).length === 0,
      `B sees ${(bReadsState ?? []).length} of A's state rows — A marked that lead "pursue" and B must not learn it`);
  } finally {
    const leftovers: string[] = [];
    for (const w of [A?.workspace, B?.workspace].filter(Boolean) as string[]) {
      for (const t of ['workspace_lead_state', 'workspace_company_state', 'leads', 'companies'] as const) {
        const { error } = await admin.from(t).delete().eq('workspace_id', w);
        if (error) leftovers.push(`${t}: ${error.message}`);
      }
    }
    for (const who of [A, B].filter(Boolean) as NonNullable<typeof A>[]) {
      const left = await removeProbe(admin, who.uid, who.workspace, null, { clearContent: true });
      if (left) leftovers.push(left);
    }
    // is_test is the predicate, not a name pattern: a sweep matching on names missed a leftover
    // workspace on 2026-09-25 because it was called "Drawer E2E Agency".
    const { data: still } = await admin.from('workspaces').select('id, name').eq('is_test', true);
    if ((still ?? []).length) leftovers.push(`is_test workspaces remain: ${(still ?? []).map((w: any) => w.name).join(', ')}`);
    check('the probe cleans up after itself', !leftovers.length, leftovers.length ? leftovers.join('; ') : 'both throwaway workspaces and everything in them are gone');
  }

  console.log(`\n${ok.length} passed, ${fail.length} failed`);
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
