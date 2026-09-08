/**
 * Signs in with the anon key exactly as the browser does, then makes the same reads the
 * server layout makes, so RLS failures surface as real error messages.
 *   npx tsx --env-file=.env.local scripts/rls-probe.ts
 */
import { createClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const EMAIL = `rls-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';

(async () => {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { name: 'RLS Probe', agency: 'RLS Probe Agency' },
  });
  if (error) { console.error('create failed:', error.message); process.exit(1); }
  const uid = created.user!.id;

  try {
    const anon = createClient(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    const { data: s, error: sErr } = await anon.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    console.log('signInWithPassword:', sErr ? 'ERROR ' + sErr.message : 'ok, session=' + !!s.session);

    console.log('\n-- reads as the signed-in user (what the /app layout does):');
    for (const [label, q] of [
      ['users (currentUser)', anon.from('users').select('*').eq('id', uid).single()],
      ['workspaces', anon.from('workspaces').select('*')],
      ['leads count', anon.from('leads').select('id', { count: 'exact', head: true })],
      ['candidates count', anon.from('candidates').select('id', { count: 'exact', head: true })],
      ['sources', anon.from('sources').select('id').limit(1)],
    ] as const) {
      const { error: e } = (await q) as any;
      console.log(`  ${String(label).padEnd(22)} ${e ? 'ERROR ' + e.code + ' — ' + e.message : 'ok'}`);
    }
  } finally {
    const { data: u } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
    await admin.auth.admin.deleteUser(uid);
    if (u?.workspace_id) await admin.from('workspaces').delete().eq('id', u.workspace_id);
    console.log('\ncleaned up probe user');
  }
})();
