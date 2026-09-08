import { createClient } from '@supabase/supabase-js';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key, { auth: { persistSession: false } });
(async () => {
  console.log('project', url);
  for (const t of ['workspaces','users','sources','candidates','documents','verifications','leads','companies','contacts','people','job_posts','campaigns']) {
    const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
    console.log(`${t.padEnd(16)} ${error ? 'MISSING (' + error.message.slice(0,60) + ')' : count + ' rows'}`);
  }
  const { data, error } = await sb.from('verifications').select('source_rows').limit(1);
  console.log('source_rows col  ', error ? 'MISSING — apply 0002' : 'present');
  const { data: ws } = await sb.from('workspaces').select('id,name').limit(10);
  console.log('workspaces:', JSON.stringify(ws));
})();
