/**
 * Item 20 step 3e: a signed-in user cannot WRITE any shared table — and is stopped by the GRANT, not the policy.
 *
 *   npx tsx --env-file=.env.local scripts/shared-write-probe.ts
 *
 * WHY THE DISTINCTION IS THE WHOLE POINT. 0053 made the seven shared reads `for select`, which already stops
 * a write — but only for as long as no permissive policy is ever added beside it. 0028's lesson is that the
 * REVOKE is the boundary and the policy is a filter over rows a caller may already touch. So this probe does
 * not merely assert "the write failed"; it asserts WHY it failed, and Postgres says which:
 *
 *   permission denied for table X            -> the GRANT is gone. This is what 0056 must produce.
 *   new row violates row-level security ...   -> the grant is still there and a POLICY refused it.
 *
 * A probe that accepted either would pass just as happily if somebody restored the grants and left the
 * policies to hold the line, which is the state 3e exists to leave behind.
 *
 * NOT JUDGED BEFORE 0056. If the refusals still read as RLS violations, the migration has not been applied
 * and this exits 2 — the same idiom industry-follow, priority-window and table-registry already use when the
 * code is ahead of the database. It does NOT exit 2 once any table is correctly permission-denied: a mixed
 * answer means something regressed on one table, and that must fail rather than read as "not applied".
 *
 * rls-sweep cannot do this job: it compares row COUNTS and never attempts a write, which is exactly how
 * 0041's hole survived a passing sweep.
 */
import { createClient } from '@supabase/supabase-js';
import { markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = probeAdmin();

/** The registry's `shared` bucket after 0055 moved sources and radar_runs out. */
const SHARED = ['leads', 'companies', 'articles', 'lead_articles', 'lead_people', 'people', 'contacts', 'company_email_patterns', 'job_posts', 'radar_verdicts'] as const;

const ok: string[] = [];
const fail: string[] = [];
const check = (name: string, pass: boolean, detail: string) => {
  (pass ? ok : fail).push(name);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
};

/**
 * A minimal payload per table, using a column that EXISTS on it. This matters more than it looks: a payload
 * naming a column the table does not have is rejected by PostgREST (PGRST204) before the request ever reaches
 * Postgres, so the grant and the policy are never consulted and the table goes UNTESTED while appearing to
 * have refused the write. The first version of this probe sent workspace_id to all ten and silently tested
 * only six. A PGRST204 is therefore treated as a PROBE FAULT and fails loudly rather than counting as a pass.
 */
const PAYLOAD: Record<string, Record<string, unknown>> = {
  leads: { workspace_id: '' },
  companies: { workspace_id: '' },
  job_posts: { workspace_id: '' },
  people: { workspace_id: '', company_name: 'Shared Write Probe', name: 'Shared Write Probe' },
  company_email_patterns: { workspace_id: '', company_id: '00000000-0000-0000-0000-000000000000', domain: 'example.invalid', pattern: 'first.last' },
  radar_verdicts: { workspace_id: '', article_id: '00000000-0000-0000-0000-000000000000' },
  articles: { url: 'https://example.invalid/shared-write-probe' },
  lead_articles: { lead_id: '00000000-0000-0000-0000-000000000000', article_id: '00000000-0000-0000-0000-000000000000' },
  lead_people: { lead_id: '00000000-0000-0000-0000-000000000000', person_id: '00000000-0000-0000-0000-000000000000' },
  contacts: { name: 'Shared Write Probe' },
};

const DENIED = /permission denied/i;
const RLS = /row-level security|violates row-level security policy/i;

async function main() {
  if (!url || !anonKey) { console.error('URL and ANON_KEY are required'); process.exitCode = 1; return; }
  const stamp = Date.now();
  const email = `shared-write-${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Shared Write Probe', agency: 'Shared Write Probe' } });
  if (made.error) { console.error(`could not create the probe account: ${made.error.message}`); process.exitCode = 1; return; }
  const uid = made.data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);

  const user = createClient(url, anonKey, { auth: { persistSession: false } });
  const signIn = await user.auth.signInWithPassword({ email, password });
  if (signIn.error) { console.error(`could not sign in: ${signIn.error.message}`); process.exitCode = 1; return; }

  let rlsRefusals = 0;
  let allowed = 0;
  let probeFaults = 0;
  try {
    for (const t of SHARED) {
      // An INSERT is the honest test: an UPDATE or DELETE that matches no row reports success having changed
      // nothing, which is Postgres's USING semantics and would read as a pass for the wrong reason.
      const body: Record<string, unknown> = { ...PAYLOAD[t] };
      if ('workspace_id' in body) body.workspace_id = workspace;
      const { error } = await user.from(t).insert(body as any);
      const msg = error?.message ?? '';
      if (!error) {
        allowed++;
        check(`${t}: a signed-in INSERT is refused`, false, 'THE INSERT SUCCEEDED — a signed-in user can write a shared table');
        continue;
      }
      if (DENIED.test(msg)) {
        check(`${t}: refused by PERMISSION, not by policy`, true, `${error.code ?? ''} ${msg}`.trim().slice(0, 96));
      } else if (RLS.test(msg)) {
        rlsRefusals++;
        check(`${t}: refused by PERMISSION, not by policy`, false, `refused by the POLICY instead — the grant is still there: ${msg.slice(0, 74)}`);
      } else if (error.code === 'PGRST204') {
        probeFaults++;
        check(`${t}: THE PROBE COULD NOT TEST THIS TABLE`, false, `the payload names a column it does not have, so nothing reached the database: ${msg.slice(0, 70)}`);
      } else {
        // A NOT NULL or foreign-key complaint means the write got PAST the grant AND the policy. That is the
        // failure being tested for: the boundary let it through and only a constraint stopped it.
        allowed++;
        check(`${t}: refused by PERMISSION, not by policy`, false, `PASSED THE BOUNDARY and failed on a constraint instead — a signed-in user can write here: ${error.code ?? ''} ${msg.slice(0, 60)}`);
      }
    }
  } finally {
    const left = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    check('the probe cleans up after itself', !left, left ?? 'the account and its workspace are gone');
  }

  const denied = SHARED.length - rlsRefusals - allowed - probeFaults;
  console.log(`\n${ok.length} passed, ${fail.length} failed — denied by GRANT ${denied}, refused by POLICY ${rlsRefusals}, WRITABLE ${allowed}, untestable ${probeFaults}`);
  // A table the probe could not reach is not evidence of anything, and must never read as a pass.
  if (probeFaults > 0) { console.log(`${probeFaults} table(s) could not be tested — fix the probe before trusting any verdict here.`); process.exitCode = 1; return; }
  // NOT JUDGED only when NOTHING was denied by grant, which is the pre-0056 shape. One denial means the
  // migration IS applied, and anything still writable after that is a regression that must fail rather
  // than be excused as "not applied yet".
  if (denied === 0) {
    console.log('0056 is NOT applied — no table refused by permission, so the write grants are still in place. Not judged.');
    process.exitCode = 2;
    return;
  }
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => { console.error(`shared write probe failed: ${e?.message ?? e}`); process.exitCode = 1; });
