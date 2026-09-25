/**
 * 0051: a workspace records state against a lead it can SEE, and against nothing else.
 *
 *   npx tsx --env-file=.env.local scripts/state-write-visibility-probe.ts
 *
 * REDESIGNED 2026-09-25, because its original premise became false by design. It used to prove that
 * B could not write state for A's lead — and B could not, because before 3c B could not SEE any of A's
 * leads. 0053 made the pool shared, so that assertion started failing for the right reason: B can see
 * A's leads now, and 0051 deliberately lets a workspace mark anything it can see.
 *
 * Scoping the old assertions to seeded rows would have left the probe passing while testing nothing:
 * with a shared pool and two unlimited accounts there is NO lead one can see and the other cannot, so
 * "cannot write what you cannot see" would have had no case to exercise.
 *
 * SO B IS NOW CAPPED, and that is what gives the probe teeth. B follows Grid only; A seeds two leads,
 * one tagged grid and one tagged oil_gas. Same workspace, same table, same moment — the ONLY difference
 * is whether entitlement admits the lead:
 *
 *     the grid lead      B can see it      →  B CAN write its own state
 *     the oil_gas lead   B cannot see it   →  B CANNOT, even on the row 0054 created for it
 *
 * That pair cannot pass vacuously: a broken WITH CHECK fails one side or the other whichever way it is
 * broken. Dropping the parent clause entirely lets the oil_gas write through; keeping 0047's ownership
 * clause blocks the grid write too, since neither lead is B's.
 *
 * THE SUBTLETY WORTH KNOWING: 0054 gives every workspace a state row for every lead, so B HAS a row for
 * the oil_gas lead and can READ it — its own row, under `workspace_id = my_workspace()`. What it cannot
 * do is WRITE it, because an UPDATE must satisfy the WITH CHECK too, and that clause asks whether the
 * lead is visible. Readable but not writable is the correct and slightly surprising answer.
 *
 * Everything it makes is removed afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { followAllForProbe, markTest, markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const fail: string[] = [];
const ok: string[] = [];
function check(name: string, pass: boolean, detail: string) {
  (pass ? ok : fail).push(`${name} — ${detail}`);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}

const admin = createClient(url, key, { auth: { persistSession: false } });

async function account(label: string, stamp: number) {
  const email = `state-visibility-${label}+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `State Visibility ${label}`, agency: `State Visibility ${label}` } });
  if (error) throw new Error(`could not create account ${label}: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  await followAllForProbe(admin, uid);
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error: signIn } = await client.auth.signInWithPassword({ email, password });
  if (signIn) throw new Error(`could not sign in as ${label}: ${signIn.message}`);
  return { uid, workspace, client };
}

async function main() {
  if (!url || !anonKey || !key) { console.error('URL, ANON_KEY and SERVICE_ROLE_KEY are required'); process.exitCode = 1; return; }

  const fn = await (admin as any).rpc('can_see_industries', { row_industries: ['grid'] });
  if (fn.error) { console.error(`can_see_industries is not callable — apply 0052/0053 first (${fn.error.code})`); process.exitCode = 2; return; }

  const stamp = Date.now();
  let A: Awaited<ReturnType<typeof account>> | null = null;
  let B: Awaited<ReturnType<typeof account>> | null = null;

  try {
    A = await account('a', stamp);
    // B is created BEFORE the leads, so 0054's leads trigger gives it a row for each of them. That is
    // what makes the writable/not-writable distinction below testable at all.
    B = await account('b', stamp);

    // CAPPED: follows Grid, limit 1. Both fields together, because 0032's trigger refuses 'all'
    // alongside a limit and refuses a limit smaller than the list.
    const { error: capErr } = await admin.from('users')
      .update({ industry_follow: ['grid'], industry_limit: 1 }).eq('id', B.uid);
    if (capErr) throw new Error(`could not cap B: ${capErr.message}`);
    const { data: cap } = await admin.from('users').select('industry_follow, industry_limit').eq('id', B.uid).maybeSingle();
    check('B is capped to Grid', JSON.stringify(cap?.industry_follow) === '["grid"]' && cap?.industry_limit === 1,
      `follow=${JSON.stringify(cap?.industry_follow)} limit=${cap?.industry_limit}`);

    const { data: co } = await admin.from('companies')
      .insert({ workspace_id: A.workspace, name: `State Visibility Co ${stamp}`, industries: ['grid'] })
      .select('id').single();
    await markTest(admin, 'companies', [co!.id]);

    const mk = async (name: string, industries: string[]) => {
      const { data, error } = await admin.from('leads')
        .insert({ workspace_id: A!.workspace, company_id: co!.id, kind: 'won_work', project_name: `${name} ${stamp}`, industries })
        .select('id').single();
      if (error) throw new Error(`could not seed ${name}: ${error.message}`);
      await markTest(admin, 'leads', [data!.id]);
      return data!.id as string;
    };
    const gridLead = await mk('Grid Lead', ['grid']);
    const oilLead = await mk('Oil Lead', ['oil_gas']);

    // ---- entitlement decides visibility, and that is the whole basis of what follows -------------
    const sees = async (id: string) => ((await B!.client.from('leads').select('id').eq('id', id)).data ?? []).length === 1;
    check('B SEES the grid lead', await sees(gridLead), 'its follow covers grid');
    check('B does NOT see the oil_gas lead', !(await sees(oilLead)),
      'capped to grid — this is the only way a lead can be invisible to a workspace now that the pool is shared');

    // ---- 0054 gave B a row for BOTH, and it can read both -------------------------------------
    const { data: bRows } = await B.client.from('workspace_lead_state')
      .select('lead_id').eq('workspace_id', B.workspace).in('lead_id', [gridLead, oilLead]);
    check('B has its own state row for BOTH leads', (bRows ?? []).length === 2,
      `${(bRows ?? []).length} of 2 — 0054 gives every workspace a row per lead, including leads it cannot see`);

    // ---- THE DISCRIMINATING PAIR ----------------------------------------------------------------
    const write = async (id: string) => {
      const { error } = await B!.client.from('workspace_lead_state')
        .update({ status: 'pursue' }).eq('workspace_id', B!.workspace).eq('lead_id', id);
      const { data: back } = await admin.from('workspace_lead_state').select('status')
        .eq('workspace_id', B!.workspace).eq('lead_id', id).maybeSingle();
      return { error, landed: back?.status === 'pursue' };
    };

    const okWrite = await write(gridLead);
    check('B CAN record state against the lead it can SEE', !okWrite.error && okWrite.landed,
      okWrite.error ? `REFUSED: ${okWrite.error.code} ${okWrite.error.message}` : 'status pursue landed — 0051 keyed the WITH CHECK on visibility');

    const badWrite = await write(oilLead);
    check('B CANNOT record state against the lead it CANNOT see', !badWrite.landed,
      badWrite.error
        ? `refused (${badWrite.error.code}) — the 0041 property, now enforced by entitlement rather than by ownership`
        : 'the update reported no error but nothing changed — RLS matched no row, which is the same protection');

    // ---- 0041's other half: not under somebody else's workspace id ------------------------------
    const { error: asA } = await B.client.from('workspace_lead_state')
      .insert({ workspace_id: A.workspace, lead_id: gridLead, status: 'contacted' });
    check("B cannot write a row carrying A's workspace id", !!asA,
      asA ? `refused (${asA.code})` : 'ACCEPTED — B can file activity as A');

    // ---- and the control, without which a refusal proves nothing --------------------------------
    // The same write the service role makes must SUCCEED, or the refusals above might be a bad id or a
    // constraint rather than the policy.
    const { error: svc } = await admin.from('workspace_lead_state')
      .update({ status: 'pursue' }).eq('workspace_id', B.workspace).eq('lead_id', oilLead);
    check('the same write SUCCEEDS for the service role', !svc,
      svc ? `also refused (${svc.code} ${svc.message}) — so what refused B may not be the policy` : 'so what refused B was RLS, not a bad id or a constraint');

    // ---- B still learns nothing about A ---------------------------------------------------------
    await admin.from('workspace_lead_state').update({ status: 'not_for_us', notes: "A's private note" })
      .eq('workspace_id', A.workspace).eq('lead_id', gridLead);
    const { data: bSeesA } = await B.client.from('workspace_lead_state')
      .select('workspace_id').eq('lead_id', gridLead).eq('workspace_id', A.workspace);
    check("B SEES NO ROW OF A'S", (bSeesA ?? []).length === 0,
      `${(bSeesA ?? []).length} row(s) carrying A's workspace_id — A marked that lead not_for_us with a note`);
    const { data: notes } = await B.client.from('workspace_lead_state').select('notes').not('notes', 'is', null);
    check('and no note written by anybody', (notes ?? []).length === 0, `${(notes ?? []).length} note(s) visible to B`);
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
    // is_test, never a name pattern: a name-matching sweep missed "Drawer E2E Agency" on 2026-09-25.
    const { data: still } = await admin.from('workspaces').select('name').eq('is_test', true);
    if ((still ?? []).length) leftovers.push(`is_test workspaces remain: ${(still ?? []).map((w: any) => w.name).join(', ')}`);
    check('the probe cleans up after itself', !leftovers.length, leftovers.length ? leftovers.join('; ') : 'both throwaway workspaces and everything in them are gone');
  }

  console.log(`\n${ok.length} passed, ${fail.length} failed`);
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
