/** What classify-employers would pick next, and whether the 57 in .cache/reclassify-before.json are among it. Read only. */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { COMPANY_STATE_LEFT, withCompanyState } from '../src/lib/workspace-state';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
(async () => {
  const before: any[] = JSON.parse(readFileSync('.cache/reclassify-before.json', 'utf8'));
  const ids = new Set(before.map((c) => c.id));
  // 0049 moved the override to workspace_company_state. The queue's own "no person has ruled on it"
  // filter was DELETED from the route in cb70d22 — reimplementing it would let one workspace's private
  // correction suppress the shared type for everybody — so this report matches the route and filters
  // on employer_type_checked_at alone, then shows the override beside each row from the state embed.
  const { data, error } = await db.from('companies').select(`id, name, careers_status, ${COMPANY_STATE_LEFT}`)
    .eq('careers_status', 'found').is('employer_type_checked_at', null).order('id').limit(5000);
  if (error) throw new Error(error.message);
  const q = (data ?? []).map(withCompanyState);
  const mine = q.filter((c: any) => ids.has(c.id));
  console.log(`queue: ${q.length} · of them the 57: ${mine.length} · others: ${q.length - mine.length}`);
  const { data: setRows } = await db.from('companies').select(`id, name, careers_status, ${COMPANY_STATE_LEFT}`).in('id', [...ids]);
  const off = (setRows ?? []).map(withCompanyState).filter((c: any) => c.careers_status !== 'found' || c.employer_type_override);
  console.log(`of the 57 not selectable: ${off.length}${off.length ? ' — ' + off.map((c: any) => `${c.name} (${c.careers_status}${c.employer_type_override ? ', override' : ''})`).join(', ') : ''}`);
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
