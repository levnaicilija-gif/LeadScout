/**
 * Merge company rows that are the same company twice.
 *
 * Everything pointing at the loser is re-pointed first, and nothing is deleted while a reference
 * survives: a company row deleted out from under a lead takes the lead's provenance with it, and
 * provenance is the one thing this system cannot rebuild.
 *
 *   npx tsx --env-file=.env.local scripts/dedupe-companies.ts           report only
 *   npx tsx --env-file=.env.local scripts/dedupe-companies.ts --write   merge them
 */
import { createClient } from '@supabase/supabase-js';
import { canonCompany, canonDomain, sameCompany } from '../src/lib/company-identity';

const write = process.argv.includes('--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

/** Every table that points at companies(id). */
const REFS: { table: string; column: string }[] = [
  { table: 'leads', column: 'company_id' },
  { table: 'contacts', column: 'company_id' },
  { table: 'job_posts', column: 'company_id' },
  { table: 'campaigns', column: 'company_id' },
  { table: 'sends', column: 'company_id' },
];

/** Prefer the row that already carries the most: a domain, a board, a real employer type. */
const weight = (c: any) =>
  (c.domain ? 8 : 0) + (c.careers_status === 'found' ? 4 : 0) + (c.employer_type_override ? 3 : 0)
  + (c.employer_type && c.employer_type !== 'unknown' ? 2 : 0) + (c.country ? 1 : 0);

(async () => {
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('companies')
      .select('id, workspace_id, name, domain, country, sector, employer_type, employer_type_override, careers_status, careers_url, ats_type, ats_slug')
      .range(from, from + 999);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`${all.length} companies\n`);

  // Candidates come from a shared canonical name or a shared domain; sameCompany decides.
  const buckets = new Map<string, any[]>();
  for (const c of all) {
    for (const key of [`n:${canonCompany(c.name)}`, c.domain ? `d:${canonDomain(c.domain)}` : null]) {
      if (!key || key === 'n:') continue;
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(c);
    }
  }

  const merges: { keep: any; drop: any; why: string }[] = [];
  const seen = new Set<string>();
  for (const group of buckets.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]; const b = group[j];
        if (a.id === b.id) continue;
        const pair = [a.id, b.id].sort().join('|');
        if (seen.has(pair)) continue;
        seen.add(pair);
        const verdict = sameCompany(a, b);
        if (!verdict.same) continue;
        const [keep, drop] = weight(a) >= weight(b) ? [a, b] : [b, a];
        merges.push({ keep, drop, why: verdict.why });
      }
    }
  }

  // A row already being dropped must never also be a survivor.
  const dropped = new Set(merges.map((m) => m.drop.id));
  const plan = merges.filter((m) => !dropped.has(m.keep.id));

  console.log(`${plan.length} merge${plan.length === 1 ? '' : 's'}:\n`);
  for (const m of plan) console.log(`  keep "${m.keep.name}"  ←  "${m.drop.name}"\n        ${m.why}`);
  if (!write) { console.log('\n(report only — pass --write to merge)'); return; }

  let done = 0;
  for (const m of plan) {
    let moved = 0;
    for (const { table, column } of REFS) {
      const { count } = await db.from(table).select('id', { count: 'exact', head: true }).eq(column, m.drop.id);
      if (!count) continue;
      const { error } = await db.from(table).update({ [column]: m.keep.id }).eq(column, m.drop.id);
      if (error) { console.log(`  could not move ${table} for ${m.drop.name}: ${error.message}`); continue; }
      moved += count;
    }
    // people carry the company by name.
    const { count: byName } = await db.from('people').select('id', { count: 'exact', head: true }).eq('company_name', m.drop.name);
    if (byName) { await db.from('people').update({ company_name: m.keep.name }).eq('company_name', m.drop.name); moved += byName; }

    // Fill any gap on the survivor from the row about to go.
    const fill: Record<string, any> = {};
    for (const k of ['domain', 'country', 'sector', 'careers_status', 'careers_url', 'ats_type', 'ats_slug', 'employer_type']) {
      const kv = m.keep[k]; const dv = m.drop[k];
      const blank = kv == null || kv === '' || kv === 'other' || kv === 'unknown';
      const useful = dv != null && dv !== '' && dv !== 'other' && dv !== 'unknown';
      if (blank && useful) fill[k] = dv;
    }
    if (Object.keys(fill).length) await db.from('companies').update(fill).eq('id', m.keep.id);

    // Refuse to delete while anything still points at it.
    let stuck = 0;
    for (const { table, column } of REFS) {
      const { count } = await db.from(table).select('id', { count: 'exact', head: true }).eq(column, m.drop.id);
      stuck += count ?? 0;
    }
    if (stuck) { console.log(`  ${m.drop.name}: ${stuck} row(s) still point at it — not deleting`); continue; }

    const { error } = await db.from('companies').delete().eq('id', m.drop.id);
    if (error) { console.log(`  could not delete ${m.drop.name}: ${error.message}`); continue; }
    done++;
    console.log(`  merged "${m.drop.name}" into "${m.keep.name}" (${moved} row${moved === 1 ? '' : 's'} moved)`);
  }
  console.log(`\n${done} merged`);
})();
