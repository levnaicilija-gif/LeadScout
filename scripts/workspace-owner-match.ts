/** Read only: does the senior of a named workspace sign in with the given e-mail? Prints match / no match, never the address. */
import { createClient } from '@supabase/supabase-js';

const [name, email] = [process.argv[2], (process.argv[3] ?? '').toLowerCase()];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const { data: ws } = await db.from('workspaces').select('id, created_at').eq('name', name);
  if (ws?.length !== 1) { console.log(`workspaces named ${name}: ${ws?.length ?? 0}`); return; }
  const { data: users } = await db.from('users').select('id, role').eq('workspace_id', ws[0].id);
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const u of users ?? []) {
    const a = list?.users.find((x) => x.id === u.id);
    console.log(`${name} (${String(ws[0].created_at).slice(0, 16)} UTC) · ${u.role} · ${a?.email?.toLowerCase() === email ? 'MATCH' : 'NO MATCH'}`);
  }
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
