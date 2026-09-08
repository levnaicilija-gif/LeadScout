import { createClient } from '@supabase/supabase-js';
const ws = process.argv[2];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  for (const t of ['sources', 'people', 'companies']) {
    const { count } = await db.from(t).select('id', { count: 'exact', head: true }).eq('workspace_id', ws);
    console.log(`${t.padEnd(10)} ${count}`);
  }
  const { data: byType } = await db.from('sources').select('type').eq('workspace_id', ws);
  const tally: Record<string, number> = {};
  for (const r of byType ?? []) tally[r.type] = (tally[r.type] ?? 0) + 1;
  console.log('sources by type:', JSON.stringify(tally));
  const { count: ops } = await db.from('people').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('ops_relevant', true);
  console.log('ops_relevant people:', ops);
  const { data: sample } = await db.from('sources').select('name,url,type').eq('workspace_id', ws).limit(3);
  console.log('sample sources:', JSON.stringify(sample, null, 1));
})();
