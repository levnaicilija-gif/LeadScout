/** What classify-employers would pick next, and whether the 57 in .cache/reclassify-before.json are among it. Read only. */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const before: any[] = JSON.parse(readFileSync('.cache/reclassify-before.json', 'utf8'));
  const ids = new Set(before.map((c) => c.id));
  const { data, error } = await db.from('companies').select('id, name, careers_status, employer_type_override')
    .eq('careers_status', 'found').is('employer_type_override', null).is('employer_type_checked_at', null).order('id').limit(5000);
  if (error) throw new Error(error.message);
  const q = data ?? [];
  const mine = q.filter((c: any) => ids.has(c.id));
  console.log(`queue: ${q.length} · of them the 57: ${mine.length} · others: ${q.length - mine.length}`);
  const { data: set } = await db.from('companies').select('id, name, careers_status, employer_type_override').in('id', [...ids]);
  const off = (set ?? []).filter((c: any) => c.careers_status !== 'found' || c.employer_type_override);
  console.log(`of the 57 not selectable: ${off.length}${off.length ? ' — ' + off.map((c: any) => `${c.name} (${c.careers_status}${c.employer_type_override ? ', override' : ''})`).join(', ') : ''}`);
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
