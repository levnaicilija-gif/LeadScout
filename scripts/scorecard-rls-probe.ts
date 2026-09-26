/**
 * 0039: only a senior may set a target, and the database is what enforces it.
 *
 *   npx tsx --env-file=.env.local scripts/scorecard-rls-probe.ts
 *
 * This is the first role check in SQL in this codebase. Everywhere else senior-only lives in a
 * route — and a route is not a boundary: a signed-in recruiter holds the anon key and can write
 * through PostgREST without going near it. That is the defect 0028 fixed on users, where a policy
 * existed and was still wrong, and scorecard_targets decides what people are measured against.
 *
 * scripts/rls-sweep.ts cannot judge this: it compares row COUNTS for a signed-in user against the
 * service role, it never tries a write, and it cannot judge a table with no rows at all. So this
 * proves it on rows that exist, with two accounts in ONE workspace — the rule under test is role,
 * not workspace:
 *   - the senior inserts, updates and deletes a target;
 *   - the recruiter can READ it (a target nobody can see is not a target);
 *   - the recruiter's insert, update and delete are all refused by the policy;
 *   - the recruiter may still write their OWN day's notes, which carry no role restriction.
 * Everything it makes is removed afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { markWorkspaceTest, removeProbe, withTransportRetry } from '../src/lib/test-data';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const stamp = Date.now();

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

async function account(tag: string) {
  const email = `scorecard-rls-${tag}+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-${tag}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `Scorecard RLS ${tag}`, agency: `Scorecard RLS ${tag}` } });
  if (error) throw new Error(`could not create account ${tag}: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  const client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { error: signIn } = await client.auth.signInWithPassword({ email, password });
  if (signIn) throw new Error(`account ${tag} could not sign in: ${signIn.message}`);
  return { uid, workspace, client, email, password };
}

/** n rows and the error, for a write that is expected to be refused as much as one that is not. */
const rows = async (q: PromiseLike<{ data: any; error: any }>) => {
  const r = await q;
  return { n: Array.isArray(r.data) ? r.data.length : r.data ? 1 : 0, error: r.error?.message ?? null };
};

(async () => {
  const { error: notThere } = await admin.from('scorecard_targets').select('id').limit(1);
  if (notThere) { console.log(`0039 is not applied — nothing to check (${notThere.code} ${notThere.message})`); process.exit(1); }

  let senior: Awaited<ReturnType<typeof account>> | null = null;
  let recruiter: Awaited<ReturnType<typeof account>> | null = null;
  try {
    senior = await account('senior');
    recruiter = await account('recruiter');
    const W = senior.workspace;
    const strandedWorkspace = recruiter.workspace;

    // One workspace, two roles: the rule under test is role, not workspace. handle_new_user makes
    // every first account a senior of its own workspace, so the recruiter is moved and demoted here.
    await admin.from('users').update({ role: 'senior', onboarding_day: 30 }).eq('id', senior.uid);
    await admin.from('users').update({ role: 'recruiter', onboarding_day: 30, workspace_id: W }).eq('id', recruiter.uid);
    // The session's claims are read per request from the users row, so both clients now see W.
    const { data: seat } = await admin.from('users').select('role, workspace_id').eq('id', recruiter.uid).single();
    check(seat?.role === 'recruiter' && seat.workspace_id === W, 'the recruiter sits in the senior\'s workspace', JSON.stringify(seat));

    console.log('\nThe senior');
    const set = await rows(senior.client.from('scorecard_targets').insert({ workspace_id: W, user_id: null, packs_prepared: 5, cvs_sent: 4, set_by: senior.uid }).select('id'));
    check(set.n === 1 && !set.error, 'a senior sets the workspace\'s targets', JSON.stringify(set));
    const { data: target } = await admin.from('scorecard_targets').select('id').eq('workspace_id', W).maybeSingle();
    const raise = await rows(senior.client.from('scorecard_targets').update({ packs_prepared: 6 }).eq('id', target!.id).select('id'));
    check(raise.n === 1 && !raise.error, 'and may change them', JSON.stringify(raise));

    console.log('\nThe recruiter');
    const read = await rows(recruiter.client.from('scorecard_targets').select('id').eq('workspace_id', W));
    check(read.n === 1 && !read.error, 'reads the targets they are measured against — a target nobody can see is not a target', JSON.stringify(read));

    const ownTarget = await rows(recruiter.client.from('scorecard_targets').insert({ workspace_id: W, user_id: recruiter.uid, packs_prepared: 1, set_by: recruiter.uid }).select('id'));
    check(ownTarget.n === 0 && !!ownTarget.error, 'cannot set a target for themselves', JSON.stringify(ownTarget));

    const softer = await rows(recruiter.client.from('scorecard_targets').update({ packs_prepared: 1 }).eq('id', target!.id).select('id'));
    const { data: afterUpdate } = await admin.from('scorecard_targets').select('packs_prepared').eq('id', target!.id).single();
    check(afterUpdate?.packs_prepared === 6, 'cannot lower the senior\'s target', `packs_prepared is ${afterUpdate?.packs_prepared} · ${JSON.stringify(softer)}`);

    await recruiter.client.from('scorecard_targets').delete().eq('id', target!.id);
    const { count: stillThere } = await admin.from('scorecard_targets').select('id', { count: 'exact', head: true }).eq('id', target!.id);
    check(stillThere === 1, 'cannot delete it either', `${stillThere} row(s) still there`);

    console.log('\nWhat a recruiter may do');
    const day = new Date().toISOString().slice(0, 10);
    const mine = await rows(recruiter.client.from('scorecards').insert({ workspace_id: W, user_id: recruiter.uid, day, notes: 'Wrote my own day.', submitted_at: new Date().toISOString() }).select('id'));
    check(mine.n === 1 && !mine.error, 'writes their own day — scorecards carries no role restriction, by design', JSON.stringify(mine));

    console.log('\nThe workspace boundary still holds');
    const elsewhere = await rows(recruiter.client.from('scorecards').insert({ workspace_id: strandedWorkspace, user_id: recruiter.uid, day, notes: 'Into another workspace.' }).select('id'));
    check(elsewhere.n === 0 && !!elsewhere.error, 'cannot write a day into another workspace (the WITH CHECK)', JSON.stringify(elsewhere));
  } finally {
    // scorecards and scorecard_targets are not in clearTestWorkspace's table list, so they go by hand.
    const left: string[] = [];
    for (const w of [senior?.workspace, recruiter?.workspace].filter(Boolean) as string[]) {
      for (const t of ['scorecards', 'scorecard_targets'] as const) {
        const { error } = await withTransportRetry(() => admin.from(t).delete().eq('workspace_id', w));
        if (error) left.push(`${t} of ${w}: ${error.message}`);
      }
    }
    for (const a of [recruiter, senior]) {
      if (!a) continue;
      const notGone = await removeProbe(admin, a.uid, a.workspace, null, { clearContent: true });
      if (notGone) left.push(notGone);
    }
    console.log(left.length ? `\ncleanup left something behind: ${left.join('; ')}` : '\nboth probe accounts and both workspaces were removed');
    if (left.length) failures++;
  }

  console.log(failures ? `\nscorecard RLS probe: ${failures} FAILED` : '\nscorecard RLS probe: all checks passed');
  process.exit(failures ? 1 : 0);
})();
