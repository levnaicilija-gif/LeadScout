/**
 * How long a signed-in session's access token lives, measured on a throwaway account. Marks its workspace is_test and
 * removes it; a leftover fails the run.
 *
 *   npx tsx --env-file=.env.local scripts/session-length-probe.ts
 *
 * Why: smoke was bounced to /login by the page (not the middleware) several minutes into a run, twice, always at the
 * same place. That fits an access token expiring mid-run far better than it fits a random network failure — but only
 * if the token lives minutes, not an hour. This says which.
 */
import { createClient } from '@supabase/supabase-js';
import { markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const email = `session-probe+${Date.now()}@rfbt-recruitment.com`;
const password = `probe-${Date.now()}-0123456789`;

(async () => {
  let uid: string | null = null;
  let workspace: string | null = null;
  try {
    const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Session Probe', agency: 'Session Probe' } });
    if (error || !created.user) throw new Error(`the probe user could not be created: ${error?.message}`);
    uid = created.user.id;
    const { data: row } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
    workspace = (row?.workspace_id as string) ?? null;
    if (workspace) await markWorkspaceTest(admin, workspace);

    const client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    const { data: signed, error: signErr } = await client.auth.signInWithPassword({ email, password });
    if (signErr || !signed.session) throw new Error(`sign-in failed: ${signErr?.message}`);
    const claims = JSON.parse(Buffer.from(signed.session.access_token.split('.')[1], 'base64url').toString('utf8'));
    console.log(`access token lifetime: ${claims.exp - claims.iat} s (expires_in ${signed.session.expires_in} s)`);
  } catch (e: any) {
    console.error(e.message ?? e);
    process.exitCode = 1;
  } finally {
    const left = await removeProbe(admin, uid, workspace);
    console.log(left ? `LEFT BEHIND: ${left}` : 'probe user and workspace removed');
    if (left) process.exitCode = 1;
  }
})();
