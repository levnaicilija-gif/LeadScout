/**
 * Load the shipped certificate library from the code tables.
 *
 * workspace_id null means "shipped with the product": every workspace reads these, and a
 * senior's edit is a separate row that shadows them. Running this again updates the shipped
 * copy and never touches what a senior has written.
 *
 *   npx tsx --env-file=.env.local scripts/seed-certs.ts
 */
import { createClient } from '@supabase/supabase-js';
import { CERT_TABLE } from '../src/lib/certs/tables';
import { writeEntry } from '../src/lib/certs/library';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  const probe = await db.from('cert_library').select('id').limit(1);
  if (probe.error) {
    console.error(`cert_library is not there yet — apply 0019 first (${probe.error.message})`);
    process.exit(1);
  }

  let done = 0;
  for (const e of CERT_TABLE) {
    const { error } = await writeEntry(db, { workspaceId: null, body: e.body, level: e.level ?? null, patch: {
      title: e.title,
      meaning: e.meaning,
      covers: e.covers,
      not_covered: e.notCovered,
      who_requires: e.whoRequires,
      typical_validity: e.validity,
      verification_route: e.verification,
      trades: e.trades,
      // Where a fact was not certain the table says so, and that travels with the row rather
      // than being lost on the way into the database.
      source: e.confirm ? `shipped — a senior must confirm: ${e.confirm}` : 'shipped',
    } });
    if (error) console.error(`  ${e.body}${e.level ? ' ' + e.level : ''}: ${error.message}`);
    else done++;
  }

  const bodies = [...new Set(CERT_TABLE.map((e) => e.body))];
  console.log(`${done}/${CERT_TABLE.length} library entries · ${bodies.length} schemes: ${bodies.join(', ')}`);
  console.log(`${CERT_TABLE.filter((e) => e.confirm).length} carry a "senior must confirm" note — they are shown as needing confirmation, not stated.`);
})();
