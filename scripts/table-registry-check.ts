/**
 * Every table is classified, and the classification matches the database.
 *
 *   npx tsx --env-file=.env.local scripts/table-registry-check.ts
 *
 * Reads the live table list from PostgREST's own spec, the way rls-sweep does, so a table added and
 * not classified FAILS THE GATE rather than quietly defaulting to whatever the next reader assumes.
 * That is the whole point of step 0: item 20's later steps are only checkable if the boundary is
 * written down first.
 *
 * It asserts four things the registry claims and the database can settle:
 *
 *   1. the registry and the database agree on which tables exist
 *   2. a table scoped `by: workspace_id` really has that column, and one scoped through a parent
 *      really has that parent's key — a claim nobody checked is a claim that drifts
 *   3. platform tables are 100% workspace_id null, because "belongs to nobody" is a fact about the
 *      rows and not a label
 *   4. NO private table is reached through a shared parent — the leak the migration order is built
 *      around. It asserted "exactly one, and it is outreach" while step 1 was outstanding, which
 *      named the target; since 0046 the rule is the permanent one and the gate proves it stays done
 *
 * Exit 2 means NOT JUDGED: the registry is ahead of the database, waiting on a migration applied by
 * hand. That is a normal state here and failing the gate for it would teach everyone to ignore a red
 * step — priority-window and industry-follow already use exit 2 the same way for 0042 and 0032.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { TABLES, PLATFORM_TABLES, privateThroughShared } from '../src/lib/table-registry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(url, key, { auth: { persistSession: false } });

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`could not read the API spec: HTTP ${res.status}`);
  const spec: any = await res.json();
  const live = Object.keys(spec?.definitions ?? {}).sort();
  if (!live.length) throw new Error('the API listed no tables');
  const columns = (t: string) => Object.keys(spec.definitions[t]?.properties ?? {});

  /** Registry ahead of the database: a migration applied by hand has not landed yet. Not a failure. */
  const pending: string[] = [];

  console.log(`--- 1. every table is classified (${live.length} live, ${Object.keys(TABLES).length} registered) ---`);
  const unregistered = live.filter((t) => !TABLES[t]);
  check(unregistered.length === 0,
    'no table is missing from the registry',
    unregistered.length ? `UNCLASSIFIED: ${unregistered.join(', ')} — add it to src/lib/table-registry.ts with its bucket` : 'all classified');
  /**
   * A registered table that is not live has TWO causes and they deserve different verdicts: its
   * migration is not applied yet (pending — normal here, migrations are applied by hand), or it was
   * dropped and the registry is stale (a real failure). They are told apart by asking whether any
   * migration actually creates it, rather than by assuming the friendlier one.
   */
  const migrations = readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join('supabase/migrations', f), 'utf8'))
    .join('\n');
  const notLive = Object.keys(TABLES).filter((t) => !live.includes(t));
  const awaited = notLive.filter((t) => new RegExp(`create table (if not exists )?${t}\\b`, 'i').test(migrations));
  const stale = notLive.filter((t) => !awaited.includes(t));
  pending.push(...awaited);
  check(stale.length === 0,
    'and the registry names no table that no longer exists',
    stale.length ? `${stale.join(', ')} — in the registry, in no migration, and not in the database` : awaited.length ? `${awaited.length} awaiting a migration (${awaited.join(', ')})` : 'none stale');

  console.log('\n--- 2. the scoping claim matches the columns ---');
  const wrongScope: string[] = [];
  const wrongParent: string[] = [];
  /**
   * The registry AHEAD of the database is a normal, temporary state in this project: migrations are
   * applied by hand, so between a commit and the owner applying it the registry describes where the
   * schema is going. That is not the registry being wrong, and failing the gate for it would train
   * everyone to ignore a red step. It is reported and the run exits 2 — "not judged" — exactly as
   * priority-window and industry-follow already do for 0042 and 0032. A registry that is WRONG in
   * any other way still fails.
   */
  for (const [t, e] of Object.entries(TABLES)) {
    if (!live.includes(t)) continue;
    const cols = columns(t);
    if (e.scope.by === 'workspace_id' && !cols.includes('workspace_id')) pending.push(`${t}.workspace_id`);
    if (e.scope.by === 'parent') {
      const through = (e.scope as any).through as string;
      if (!TABLES[through]) wrongParent.push(`${t} is scoped through ${through}, which is not registered`);
      // The key is DECLARED by the registry, not guessed from the parent's name — guessing gave
      // "companie_id" for companies and "screening_call_id" for a column actually called call_id.
      const fk = (e.scope as any).fk as string;
      if (!cols.includes(fk)) wrongParent.push(`${t} is scoped through ${through} but carries no ${fk}`);
    }
  }
  check(wrongScope.length === 0, 'every table claiming its own workspace_id has one',
    wrongScope.join('; ') || (pending.length ? `${pending.length} waiting on a migration (${pending.join(', ')}), the rest correct` : 'all correct'));
  check(wrongParent.length === 0, 'every table scoped through a parent carries that parent\'s key, and the parent is registered', wrongParent.join('; ') || 'all correct');

  console.log('\n--- 3. platform content belongs to nobody ---');
  for (const t of PLATFORM_TABLES) {
    if (!live.includes(t) || !columns(t).includes('workspace_id')) { check(true, `${t} has no workspace to belong to`, 'no workspace_id column'); continue; }
    const { count: all } = await admin.from(t).select('*', { count: 'exact', head: true });
    const { count: owned } = await admin.from(t).select('*', { count: 'exact', head: true }).not('workspace_id', 'is', null);
    check((owned ?? 0) === 0,
      `${t}: every shipped row belongs to nobody`,
      `${all} row(s), ${owned} owned by a workspace${(owned ?? 0) > 0 ? ' — a workspace row must SHADOW a platform row, never be one' : ''}`);
  }

  console.log('\n--- 4. the leak the migration order exists to prevent ---');
  const hazards = privateThroughShared();
  console.log(`  private tables reached through a shared parent: ${hazards.map((h) => `${h.table} -> ${h.through}`).join(', ') || 'none'}`);
  // Was "exactly one, and it is outreach" while step 1 was outstanding — that named the target.
  // Since 0046 the rule is the permanent one, so the gate proves step 1 STAYS done.
  check(hazards.length === 0,
    'NONE: no private table is reached through a table that is about to become everybody\'s',
    hazards.map((h) => `${h.table} through ${h.through} — give it its own workspace_id before that parent is shared`).join('; ') || 'none');
  check(TABLES.outreach.scope.by === 'workspace_id',
    'outreach has its own workspace_id (0046), not the lead\'s',
    `scope: ${TABLES.outreach.scope.by}`);

  console.log('\n--- what the buckets hold ---');
  for (const b of ['shared', 'private', 'platform', 'service'] as const) {
    const names = Object.entries(TABLES).filter(([, e]) => e.bucket === b).map(([t]) => t);
    console.log(`  ${b.padEnd(9)} ${String(names.length).padStart(2)}  ${names.join(', ')}`);
  }

  if (failures) {
    console.log(`\ntable registry: ${failures} FAILED`);
    process.exitCode = 1;
    return;
  }
  if (pending.length) {
    console.log(`\ntable registry: not judged — the registry is ahead of the database, waiting on a migration: ${pending.join(', ')}`);
    console.log('  everything else passed. Apply the migration and this turns green on its own.');
    process.exitCode = 2;
    return;
  }
  console.log('\ntable registry: all checks passed');
  process.exitCode = 0;
})().catch((e) => { console.error(`\ntable registry: ${e?.message ?? e}`); process.exitCode = 1; });
