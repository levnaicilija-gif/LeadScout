/**
 * Row level security, table by table, as a signed-in user — part of the release gate.
 *
 *   npx tsx --env-file=.env.local scripts/rls-sweep.ts               # sweep, print, record the result
 *   npx tsx --env-file=.env.local scripts/rls-sweep.ts --no-record   # sweep and print only
 *
 * The rules are src/lib/rls-sweep.ts, shared with the nightly run. It reads the live database, so a
 * gate run catches a table left unreadable by a migration or by a dashboard toggle alike.
 *
 * Writes nothing but a throwaway user and its test-marked workspace (deleted afterwards) and, once
 * 0026 exists, one health_checks row. Exits 1 if any table is SUSPECT, if the catalogue names a
 * table with RLS on and no policy, or if the sweep could not run.
 */
import { createClient } from '@supabase/supabase-js';
import { runRlsSweep, recordRlsSweep, sweepSummary } from '../src/lib/rls-sweep';

(async () => {
  const r = await runRlsSweep();
  console.log(`${'table'.padEnd(26)}${'service'.padStart(9)}${'expected'.padStart(10)}${'user'.padStart(9)}  verdict`);
  for (const row of r.rows) {
    console.log(`${row.table.padEnd(26)}${String(row.service).padStart(9)}${String(row.expected ?? '-').padStart(10)}${String(row.user).padStart(9)}  ${row.verdict}`);
  }
  console.log(`\nnot judged by counting (no rows): ${r.unjudged.join(', ') || 'none'}`);
  console.log(r.catalog.checked
    ? `catalogue: ${r.catalog.noPolicy.length ? `RLS on with no policy — ${r.catalog.noPolicy.join(', ')}` : 'no table has RLS on without a policy'}`
    : 'catalogue: not checked (rls_tables_without_policy arrives with migration 0026)');
  if (!process.argv.includes('--no-record')) {
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const notKept = await recordRlsSweep(admin, r, process.env.RLS_SWEEP_SOURCE === 'gate' ? 'gate' : 'manual');
    console.log(notKept ? `result not recorded: ${notKept}` : 'result recorded for Home');
  }
  console.log(sweepSummary(r));
  // A leftover throwaway user or workspace fails the gate too: it is not an RLS failure, but a cleanup
  // nobody hears about is how test rows pile up in the real database.
  process.exit(r.ok && !r.cleanupError ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
