/**
 * Can a signed-in user change who they are, where they belong, or a teammate? They must not.
 *
 *   npx tsx --env-file=.env.local scripts/users-policy-probe.ts
 *
 * Uses ONLY two throwaway accounts, each in its own new test-marked workspace; the real workspace and
 * every real user are never touched. Signed in as A with the public key, it tries six writes:
 *   1. change A's own role
 *   2. move A's own row into B's workspace (and then read B's workspace)
 * and then, with A placed in B's workspace as a teammate:
 *   3. rename B
 *   4. change B's role
 *   5. change B's onboarding_day, which unlocks screens early
 *   6. delete B's users row
 * On 2026-09-14, before migration 0028, all six succeeded. Exits 1 while any of them does, 0 once all six
 * are refused. Both accounts and both workspaces are removed afterwards; a leftover also exits 1.
 */
import { createClient } from '@supabase/supabase-js';
import { markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const make = async (tag: string) => {
  const email = `users-policy-${tag}+${Date.now()}@rfbt-recruitment.com`;
  const password = `${crypto.randomUUID()}-Aa1`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `Policy Probe ${tag}`, agency: `Policy Probe ${tag}` } });
  if (error) throw new Error(`could not create probe ${tag}: ${error.message}`);
  const uid = data.user!.id;
  const { data: row } = await admin.from('users').select('workspace_id, role, name, onboarding_day').eq('id', uid).single();
  await markWorkspaceTest(admin, row!.workspace_id);
  return { email, password, uid, ws: row!.workspace_id as string, role: row!.role as string, name: row!.name as string, day: row!.onboarding_day as number };
};

(async () => {
  const { data: real } = await admin.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const a = await make('a');
  const b = await make('b');
  if (a.ws === real!.id || b.ws === real!.id) { console.log('a probe landed in the real workspace — stopping'); process.exit(1); }
  const state = async (uid: string) => (await admin.from('users').select('role, workspace_id, name, onboarding_day').eq('id', uid).maybeSingle()).data;
  try {
    const asA = createClient(URL_, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    const { error: signIn } = await asA.auth.signInWithPassword({ email: a.email, password: a.password });
    if (signIn) throw new Error(`probe A could not sign in: ${signIn.message}`);

    const newRole = a.role === 'senior' ? 'recruiter' : 'senior';
    const r1 = await asA.from('users').update({ role: newRole }).eq('id', a.uid).select('id');
    const afterRole = await state(a.uid);
    check(afterRole?.role === a.role, "a signed-in user cannot change their own role",
      `tried ${a.role} → ${newRole}: ${r1.error ? `refused (${r1.error.message})` : `${r1.data?.length ?? 0} row(s) written`}, role is now ${afterRole?.role}`);

    const r2 = await asA.from('users').update({ workspace_id: b.ws }).eq('id', a.uid).select('id');
    const afterMove = await state(a.uid);
    const readB = await asA.from('workspaces').select('id').eq('id', b.ws);
    check(afterMove?.workspace_id === a.ws && (readB.data?.length ?? 0) === 0, "a signed-in user cannot move into another workspace",
      `${r2.error ? `refused (${r2.error.message})` : `${r2.data?.length ?? 0} row(s) written`}; can read the other workspace: ${(readB.data?.length ?? 0) > 0}`);

    // Put A into B's workspace with the service role, so this tests a teammate's row, not a stranger's.
    await admin.from('users').update({ workspace_id: b.ws }).eq('id', a.uid);
    const r3 = await asA.from('users').update({ name: 'renamed by A' }).eq('id', b.uid).select('id');
    const afterRename = await state(b.uid);
    check(afterRename?.name === b.name, "a signed-in user cannot edit a teammate's row",
      `${r3.error ? `refused (${r3.error.message})` : `${r3.data?.length ?? 0} row(s) written`}; teammate's name is now "${afterRename?.name}"`);

    const teammateRole = b.role === 'senior' ? 'recruiter' : 'senior';
    const r4 = await asA.from('users').update({ role: teammateRole }).eq('id', b.uid).select('id');
    const afterTeammateRole = await state(b.uid);
    check(afterTeammateRole?.role === b.role, "a signed-in user cannot change a teammate's role",
      `tried ${b.role} → ${teammateRole}: ${r4.error ? `refused (${r4.error.message})` : `${r4.data?.length ?? 0} row(s) written`}; teammate's role is now ${afterTeammateRole?.role}`);

    const r5 = await asA.from('users').update({ onboarding_day: 10 }).eq('id', b.uid).select('id');
    const afterDay = await state(b.uid);
    check(afterDay?.onboarding_day === b.day, "a signed-in user cannot change a teammate's onboarding day",
      `tried ${b.day} → 10: ${r5.error ? `refused (${r5.error.message})` : `${r5.data?.length ?? 0} row(s) written`}; teammate's onboarding day is now ${afterDay?.onboarding_day}`);

    const r6 = await asA.from('users').delete().eq('id', b.uid).select('id');
    const afterDelete = await state(b.uid);
    check(!!afterDelete, "a signed-in user cannot delete a teammate's row",
      `${r6.error ? `refused (${r6.error.message})` : `${r6.data?.length ?? 0} row(s) deleted`}; teammate's row ${afterDelete ? 'still exists' : 'is GONE'}`);
    // If the delete ever succeeds, put the row back so cleanup still removes a whole account.
    if (!afterDelete) await admin.from('users').insert({ id: b.uid, workspace_id: b.ws, name: b.name, role: b.role, onboarding_day: b.day });
  } finally {
    // A's row may point at B's workspace now: put it back, so each workspace goes with its own user.
    await admin.from('users').update({ workspace_id: a.ws }).eq('id', a.uid);
    const leftA = await removeProbe(admin, a.uid, a.ws, real!.id);
    const leftB = await removeProbe(admin, b.uid, b.ws, real!.id);
    check(!leftA && !leftB, 'both probe accounts and both workspaces removed', [leftA, leftB].filter(Boolean).join('; '));
  }
  console.log(failures === 0 ? '\nusers policy: no signed-in user can change who they are, where they belong, or a teammate' : `\nusers policy: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
