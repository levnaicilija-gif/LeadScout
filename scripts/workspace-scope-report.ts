/** Read only: how many workspaces exist and which of them holds the crawl's sources, leads, companies and job posts. */
import { createClient } from '@supabase/supabase-js';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
const count = async (t: string, ws: string | null) => {
  let q = db.from(t).select('id', { count: 'exact', head: true });
  q = ws === null ? q.is('workspace_id', null) : q.eq('workspace_id', ws);
  const { count: n, error } = await q;
  return error ? `err ${error.message}` : n;
};
(async () => {
  const { data: wss, error } = await db.from('workspaces').select('id, name, is_test, created_at').order('created_at');
  const rows = error ? (await db.from('workspaces').select('id, name')).data ?? [] : wss ?? [];
  console.log(`workspaces: ${rows.length}`);
  for (const w of [...rows, { id: null, name: '(no workspace)' } as any]) {
    const [src, leads, cos, posts, users] = await Promise.all(['sources', 'leads', 'companies', 'job_posts', 'users'].map((t) => count(t, w.id)));
    console.log(`  ${w.name}${w.is_test ? ' [test]' : ''} ${w.created_at?.slice(0, 10) ?? ''} · users ${users} · sources ${src} · leads ${leads} · companies ${cos} · job_posts ${posts}`);
  }
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
