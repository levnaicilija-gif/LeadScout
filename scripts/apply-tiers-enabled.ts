/**
 * Half of the classification result that can land before migration 0011: switch off the
 * sources scored irrelevant. `enabled` already exists, so this needs no schema change; the
 * scores, topics and written reasons stay in .cache/source-tiers.json until 0011 is applied
 * and scripts/classify-sources.ts --apply writes them onto the rows.
 */
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const verdicts = JSON.parse(fs.readFileSync('.cache/source-tiers.json', 'utf8')) as any[];

(async () => {
  const off = verdicts.filter((v) => v.tier === 'off').map((v) => v.id);
  const on = verdicts.filter((v) => v.tier !== 'off').map((v) => v.id);
  for (let i = 0; i < off.length; i += 100) {
    const { error } = await db.from('sources').update({ enabled: false }).in('id', off.slice(i, i + 100));
    if (error) throw new Error(error.message);
  }
  for (let i = 0; i < on.length; i += 100) {
    const { error } = await db.from('sources').update({ enabled: true }).in('id', on.slice(i, i + 100));
    if (error) throw new Error(error.message);
  }
  const { count } = await db.from('sources').select('id', { count: 'exact', head: true }).eq('enabled', true);
  console.log(`switched off ${off.length}, left on ${on.length} — ${count} sources now enabled`);
})();
