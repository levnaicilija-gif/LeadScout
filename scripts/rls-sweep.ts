/**
 * Row level security, table by table: does a signed-in user see what they should?
 *
 *   npx tsx --env-file=.env.local scripts/rls-sweep.ts
 *
 * Reads every table the API exposes, counts rows as the service role and as a throwaway user placed
 * in the real workspace, and compares. The pattern it hunts is RLS switched on with no policy: the
 * user reads nothing and gets no error. That hid organisation-page contacts until 0022, and articles,
 * lead_articles and lead_people until 0025 — each found only when a feature happened to read one.
 *
 * SUSPECT means the service role sees rows (in this workspace, where the table has workspace_id) and
 * the user sees fewer or none. A table with no rows cannot be judged and is listed as such. A user
 * seeing more than the workspace holds is shared rows (shipped cert library, glossary, trade cards).
 *
 * Writes nothing but the throwaway user and its test-marked workspace, deleted afterwards.
 * Exits 1 if any table is SUSPECT or errors for the user.
 */
import { createClient } from '@supabase/supabase-js';
import { markWorkspaceTest } from '../src/lib/test-data';

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const EMAIL = `rls-sweep+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';

(async () => {
  const spec: any = await (await fetch(`${URL_}/rest/v1/`, { headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } })).json();
  const tables = Object.keys(spec.definitions ?? {}).sort();
  // workspaces is scoped by its own id: a user sees their workspace and no other, which is correct.
  const hasWorkspace = (t: string) => t === 'workspaces' || Object.keys(spec.definitions[t]?.properties ?? {}).includes('workspace_id');
  const { data: ws } = await admin.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();

  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'RLS Sweep', agency: 'RLS Sweep' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: own } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const throwaway = own?.workspace_id as string;
  const suspects: string[] = [];
  const unjudged: string[] = [];
  try {
    await markWorkspaceTest(admin, throwaway);
    await admin.from('users').update({ workspace_id: ws!.id }).eq('id', uid);
    const user = createClient(URL_, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    const { error: signIn } = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (signIn) throw new Error(signIn.message);

    const count = async (c: any, t: string, workspaceOnly = false): Promise<number | string> => {
      let q = c.from(t).select('*', { count: 'exact', head: true });
      if (workspaceOnly) q = q.eq(t === 'workspaces' ? 'id' : 'workspace_id', ws!.id);
      const { count: n, error: e } = await q;
      return e ? `error ${e.code ?? ''} ${e.message.slice(0, 60)}` : (n ?? 0);
    };

    console.log(`${'table'.padEnd(26)}${'service'.padStart(9)}${'in ws'.padStart(9)}${'user'.padStart(9)}  verdict`);
    for (const t of tables) {
      const scoped = hasWorkspace(t);
      const all = await count(admin, t);
      const inWs = scoped ? await count(admin, t, true) : null;
      const seen = await count(user, t);
      const expected = scoped ? inWs : all;
      let verdict = 'ok';
      if (typeof seen === 'string') { verdict = `SUSPECT — the user gets ${seen}`; suspects.push(t); }
      else if (all === 0) { verdict = 'not judged — no rows'; unjudged.push(t); }
      else if (typeof expected === 'number' && seen < expected) { verdict = `SUSPECT — the user sees ${seen} of ${expected}`; suspects.push(t); }
      else if (typeof expected === 'number' && seen > expected) verdict = 'ok — shared rows beyond the workspace';
      else if (scoped && inWs === 0) verdict = 'ok — no rows in this workspace';
      console.log(`${t.padEnd(26)}${String(all).padStart(9)}${String(inWs ?? '-').padStart(9)}${String(seen).padStart(9)}  ${verdict}`);
    }
  } finally {
    await admin.auth.admin.deleteUser(uid);
    if (throwaway && throwaway !== ws!.id) await admin.from('workspaces').delete().eq('id', throwaway).eq('is_test', true);
  }
  console.log(`\nnot judged (no rows): ${unjudged.join(', ') || 'none'}`);
  console.log(suspects.length ? `rls sweep: ${suspects.length} SUSPECT — ${suspects.join(', ')}` : 'rls sweep: every table with rows reads the same for a signed-in user as for the service role');
  process.exit(suspects.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
