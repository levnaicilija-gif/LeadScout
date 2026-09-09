/** Probe the live database for each migration's artifacts. npx tsx --env-file=.env.local scripts/migrations-status.ts */
import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const col = async (table: string, column: string) => {
  const { error } = await db.from(table).select(column).limit(1);
  return !error;
};
const fn = async (name: string, arg: any) => {
  const { error } = await db.rpc(name, arg);
  return !error || !/does not exist|not find/i.test(error.message);
};

(async () => {
  const checks: [string, string, () => Promise<boolean>][] = [
    ['0001', 'base schema (companies table)', () => col('companies', 'id')],
    ['0002', 'verifications.source_rows', () => col('verifications', 'source_rows')],
    ['0003', 'my_workspace() security definer', async () => { const { error } = await db.from('sources').select('id').limit(1); return !error; }],
    ['0004', 'contacts(lead_id,name) unique index', async () => {
      // If the index is missing, an upsert with that conflict target is rejected outright.
      const { error } = await db.from('contacts').upsert([], { onConflict: 'lead_id,name' as any });
      return !error || !/no unique|constraint matching/i.test(error.message);
    }],
    ['0005', 'sources.link_rule', () => col('sources', 'link_rule')],
    ['0006a', 'companies.tier', () => col('companies', 'tier')],
    ['0006b', 'companies.ats_type', () => col('companies', 'ats_type')],
    ['0006c', 'job_posts.company_id', () => col('job_posts', 'company_id')],
    ['0006d', 'cost_log table', () => col('cost_log', 'id')],
    ['0006e', 'leads.country', () => col('leads', 'country')],
    ['0006f', 'is_european() sql function', () => fn('is_european', { cc: 'DK' })],
  ];
  for (const [id, what, test] of checks) {
    let ok = false;
    try { ok = await test(); } catch { ok = false; }
    console.log(`${ok ? 'APPLIED ' : 'PENDING '} ${id.padEnd(6)} ${what}`);
  }
})();
