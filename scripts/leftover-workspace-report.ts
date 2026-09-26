/** Read only: what a probe workspace still holds, and whether every row is marked is_test. `npx tsx --env-file=.env.local scripts/leftover-workspace-report.ts <workspace-id>` */
import { createClient } from '@supabase/supabase-js';
import { probeAdmin } from '../src/lib/test-data';

const id = process.argv[2];
const db = probeAdmin();
(async () => {
  const { data: ws } = await db.from('workspaces').select('id, name, is_test, created_at').eq('id', id).maybeSingle();
  console.log(`workspace: ${JSON.stringify(ws)}`);
  if (!ws) return;
  const { data: users } = await db.from('users').select('id, role').eq('workspace_id', id);
  console.log(`users: ${users?.length ?? 0}`);
  const { data: cos } = await db.from('companies').select('id, name, is_test').eq('workspace_id', id);
  console.log(`companies: ${JSON.stringify(cos)}`);
  const { data: leads } = await db.from('leads').select('id, project_name, is_test').eq('workspace_id', id);
  console.log(`leads: ${JSON.stringify(leads)}`);
  const coIds = (cos ?? []).map((c) => c.id);
  const { data: posts } = coIds.length ? await db.from('job_posts').select('id, title, is_test').in('company_id', coIds) : { data: [] as any[] };
  console.log(`job_posts on those companies: ${JSON.stringify(posts)}`);
  for (const t of ['candidates', 'documents', 'cost_log', 'people', 'radar_runs']) {
    const { count, error } = await db.from(t).select('*', { count: 'exact', head: true }).eq('workspace_id', id);
    console.log(`${t}: ${error ? `n/a (${error.message.slice(0, 50)})` : count}`);
  }
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
