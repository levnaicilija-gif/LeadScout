/**
 * Merge two company rows that are the same company spelled twice.
 *
 * Everything that points at the loser is re-pointed first, and the merge refuses to run if any
 * reference is left behind — a company row deleted out from under a lead takes the lead's
 * provenance with it, and provenance is the one thing this system cannot rebuild.
 *
 * The survivor keeps the better-filled row: for each field, whichever side actually has a value.
 *
 *   npx tsx --env-file=.env.local scripts/merge-companies.ts "Ørsted" "Orsted"
 *   npx tsx --env-file=.env.local scripts/merge-companies.ts --write "Ørsted" "Orsted"
 */
import { createClient } from '@supabase/supabase-js';

const write = process.argv.includes('--write');
const [keepName, dropName] = process.argv.slice(2).filter((a) => a !== '--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

/** Every table that points at companies(id), from the schema. */
const REFS: { table: string; column: string }[] = [
  { table: 'leads', column: 'company_id' },
  { table: 'contacts', column: 'company_id' },
  { table: 'job_posts', column: 'company_id' },
  { table: 'campaigns', column: 'company_id' },
  { table: 'sends', column: 'company_id' },
];

(async () => {
  if (!keepName || !dropName) { console.error('usage: merge-companies.ts [--write] "<keep>" "<drop>"'); process.exit(1); }

  const one = async (name: string) => {
    const { data } = await db.from('companies').select('*').eq('name', name);
    if (!data?.length) throw new Error(`no company named exactly "${name}"`);
    if (data.length > 1) throw new Error(`${data.length} companies named "${name}" — too ambiguous to merge`);
    return data[0];
  };
  const keep = await one(keepName);
  const drop = await one(dropName);
  console.log(`keep  ${keep.name}  ${keep.id}  domain=${keep.domain ?? '—'} sector=${keep.sector ?? '—'} country=${keep.country ?? '—'}`);
  console.log(`drop  ${drop.name}  ${drop.id}  domain=${drop.domain ?? '—'} sector=${drop.sector ?? '—'} country=${drop.country ?? '—'}\n`);

  for (const { table, column } of REFS) {
    const { count, error } = await db.from(table).select('id', { count: 'exact', head: true }).eq(column, drop.id);
    if (error) { console.log(`  ${table}: cannot read (${error.message.slice(0, 60)})`); continue; }
    console.log(`  ${table}.${column}: ${count} row(s) to re-point`);
    if (!write || !count) continue;
    const { error: upd } = await db.from(table).update({ [column]: keep.id }).eq(column, drop.id);
    if (upd) throw new Error(`could not re-point ${table}: ${upd.message}`);
  }

  // people carry the company by name, not by id.
  const { count: byName } = await db.from('people').select('id', { count: 'exact', head: true }).eq('company_name', drop.name);
  console.log(`  people.company_name = "${drop.name}": ${byName} row(s)`);
  if (write && byName) {
    const { error } = await db.from('people').update({ company_name: keep.name }).eq('company_name', drop.name);
    if (error) throw new Error(`could not re-point people: ${error.message}`);
  }

  // Fill any gap on the survivor from the row about to go.
  const fill: Record<string, any> = {};
  for (const k of ['domain', 'sector', 'country', 'region', 'tier', 'size_band', 'employer_type', 'careers_url', 'switchboard', 'general_email', 'email_pattern', 'source', 'source_url']) {
    const kv = (keep as any)[k], dv = (drop as any)[k];
    const blank = (v: any) => v == null || v === '' || v === 'other' || v === 'unknown';
    // Only fill a gap with something that is actually an answer.
    if (blank(kv) && !blank(dv)) fill[k] = dv;
  }
  if (Object.keys(fill).length) console.log(`\n  filling from the dropped row: ${JSON.stringify(fill)}`);
  if (write && Object.keys(fill).length) {
    const { error } = await db.from('companies').update(fill).eq('id', keep.id);
    if (error) throw new Error(`could not fill the survivor: ${error.message}`);
  }

  if (!write) { console.log('\n(dry run — pass --write to merge)'); return; }

  // Refuse to delete while anything still points at it.
  for (const { table, column } of REFS) {
    const { count, error } = await db.from(table).select('id', { count: 'exact', head: true }).eq(column, drop.id);
    if (!error && count) throw new Error(`${table} still has ${count} row(s) pointing at ${drop.name} — not deleting`);
  }
  const { error } = await db.from('companies').delete().eq('id', drop.id);
  if (error) throw new Error(`could not delete ${drop.name}: ${error.message}`);
  console.log(`\nmerged "${drop.name}" into "${keep.name}"`);
})().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
