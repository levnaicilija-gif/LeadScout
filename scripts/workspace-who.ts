/** Read only: who is in each workspace (role, created, sign-in method, e-mail domain only), and whether it is marked test. */
import { createClient } from '@supabase/supabase-js';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
(async () => {
  const { data: wss } = await db.from('workspaces').select('*');
  const { data: users } = await db.from('users').select('id, workspace_id, role, name, industry_follow, industry_limit');
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const w of wss ?? []) {
    console.log(`${w.name} · slug ${w.slug} · created ${String(w.created_at).slice(0, 16)} · is_test ${w.is_test ?? '—'}`);
    for (const u of (users ?? []).filter((x: any) => x.workspace_id === w.id)) {
      const a = list?.users.find((x) => x.id === u.id);
      console.log(`  user role ${u.role} · follow ${JSON.stringify(u.industry_follow)} · limit ${u.industry_limit} · auth created ${a?.created_at?.slice(0, 16)} · last sign-in ${a?.last_sign_in_at?.slice(0, 16)} · email domain ${a?.email?.split('@')[1]} · agency meta ${JSON.stringify(a?.user_metadata?.agency ?? null)}`);
    }
  }
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
