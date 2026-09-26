/**
 * Item 20 step 4: a brand-new workspace reads NONE of another workspace's private rows. Registry-driven.
 *
 *   npx tsx --env-file=.env.local scripts/private-leak-probe.ts
 *
 * WHY THIS EXISTS WHEN NINE RLS PROBES ALREADY DO. Each of those proves its own table: outreach-rls-probe,
 * candidate-rls-probe, scorecard-rls-probe, screening-rls-probe, state-write-visibility-probe and the rest.
 * The registry now lists two dozen PRIVATE tables, and a survey of the probe scripts found 21 of them merely
 * MENTIONED somewhere — which is not the same as asserted. A probe that seeds a table in setup and deletes it
 * in teardown "mentions" it while proving nothing about who can read it.
 *
 * So this asks one question of EVERY private table at once, and takes its list from table-registry.ts rather
 * than from a hand-kept array. A table added to the registry as private is covered here the moment it is
 * added; a table that changes bucket changes what is asserted about it. There is nothing to keep in sync,
 * which is the only kind of coverage that survives.
 *
 * THE ASSERTION IS THE SIMPLEST HONEST ONE. B is a workspace created seconds ago that has done nothing, so
 * for every private table it must read EXACTLY ZERO ROWS — every row in those tables belongs to somebody
 * else. Two tables are the deliberate exception: `users` and `workspaces`, where B legitimately reads its own
 * single row and must read no other. A count of zero on an empty table proves nothing, so a table the service
 * role also finds empty is reported NOT JUDGED rather than passed — the same honesty rls-sweep already applies
 * to tables with no rows, and the reason 0041's hole survived a passing sweep.
 *
 * It does not attempt writes: shared-write-probe covers the shared bucket by grant, and the per-table RLS
 * probes cover private writes. This is the read boundary, which is the one a new CUSTOMER meets first.
 */
import { createClient } from '@supabase/supabase-js';
import { TABLES } from '../src/lib/table-registry';
import { markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = probeAdmin();

/** B reads its own row in these and only its own; everywhere else the answer must be zero. */
const OWN_ROW_EXPECTED = new Set(['users', 'workspaces']);

const ok: string[] = [];
const fail: string[] = [];
const notJudged: string[] = [];
const check = (name: string, pass: boolean, detail: string) => {
  (pass ? ok : fail).push(name);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
};

async function main() {
  if (!url || !anonKey) { console.error('URL and ANON_KEY are required'); process.exitCode = 1; return; }
  const priv = Object.entries(TABLES).filter(([, e]) => e.bucket === 'private').map(([t]) => t).sort();
  console.log(`${priv.length} private table(s) in the registry\n`);

  const stamp = Date.now();
  const email = `private-leak-${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Private Leak Probe', agency: 'Private Leak Probe' } });
  if (made.error) { console.error(`could not create the probe account: ${made.error.message}`); process.exitCode = 1; return; }
  const uid = made.data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);

  const b = createClient(url, anonKey, { auth: { persistSession: false } });
  const signIn = await b.auth.signInWithPassword({ email, password });
  if (signIn.error) { console.error(`could not sign in as B: ${signIn.error.message}`); process.exitCode = 1; return; }

  try {
    for (const t of priv) {
      // What exists at all. A table the SERVICE ROLE finds empty cannot be judged by counting.
      const total = await admin.from(t).select('*', { count: 'exact', head: true });
      if (total.error) { check(`${t}: readable by the service role`, false, `${total.error.code ?? ''} ${total.error.message}`.trim().slice(0, 90)); continue; }
      const seen = await b.from(t).select('*', { count: 'exact', head: true });
      const bCount = seen.error ? null : (seen.count ?? 0);

      if ((total.count ?? 0) === 0) {
        notJudged.push(t);
        console.log(`--   ${t}: NOT JUDGED — the table is empty, so a count of zero proves nothing`);
        continue;
      }

      if (OWN_ROW_EXPECTED.has(t)) {
        // Exactly its own: one row, and it must be B's. More than one is a leak; none means B cannot see itself.
        const rows = await b.from(t).select('id').limit(5);
        const ids = (rows.data ?? []).map((r: any) => r.id);
        const expected = t === 'users' ? [uid] : [workspace];
        const right = !rows.error && ids.length === 1 && ids[0] === expected[0];
        check(`${t}: B reads its OWN row and no other`, right,
          rows.error ? `read failed: ${rows.error.message}` : `${ids.length} row(s) of ${total.count}, ${right ? 'its own' : `unexpected: ${JSON.stringify(ids)}`}`);
        continue;
      }

      if (seen.error) {
        // A refusal is a stronger answer than zero rows: the grant or the policy stopped it outright.
        check(`${t}: B reads nothing that is not its own`, true, `refused outright — ${seen.error.code ?? ''} ${seen.error.message}`.trim().slice(0, 88));
        continue;
      }

      // THE ASSERTION IS "NOTHING THAT IS NOT B'S", NOT "NOTHING AT ALL", and the first version of this probe
      // got that wrong in a way worth recording: it reported workspace_lead_state as a LEAK because B read 238
      // rows. B owned all 238 — 0054 gives every workspace a row for every lead the moment the workspace is
      // created, so a brand-new workspace legitimately has rows there before it has done anything. Checked
      // directly rather than assumed: B saw 238, all 238 its own, 0 belonging to anyone else, against 714 for
      // the service role. So a table where B may hold its own rows is judged on the ROWS THAT ARE NOT ITS,
      // which is the question that was always being asked and is also strictly stronger — it still catches a
      // leak on a table where B happens to own something.
      const scope = (TABLES as any)[t]?.scope;
      if (scope?.by === 'workspace_id') {
        const foreign = await b.from(t).select('*', { count: 'exact', head: true }).neq('workspace_id', workspace);
        const n = foreign.error ? null : (foreign.count ?? 0);
        check(`${t}: B reads nothing that is not its own`, n === 0, foreign.error
          ? `read failed: ${foreign.error.message}`
          : `${n} foreign row(s) of ${total.count}; B's own visible: ${bCount}${n === 0 ? '' : ' — LEAK'}`);
      } else {
        // No workspace_id to filter on: the table is reached through a parent, and B has no parents yet, so
        // anything it can see at all belongs to somebody else.
        check(`${t}: B reads nothing that is not its own`, bCount === 0, bCount === 0
          ? `0 of ${total.count} row(s), and B owns no parent row to reach any`
          : `LEAK — B reads ${bCount} of ${total.count} row(s) through a parent it does not own`);
      }
    }
  } finally {
    const left = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    check('the probe cleans up after itself', !left, left ?? 'the account and its workspace are gone');
  }

  console.log(`\n${ok.length} passed, ${fail.length} failed, ${notJudged.length} not judged (empty)`);
  if (notJudged.length) console.log(`not judged: ${notJudged.join(', ')}`);
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => { console.error(`private leak probe failed: ${e?.message ?? e}`); process.exitCode = 1; });
