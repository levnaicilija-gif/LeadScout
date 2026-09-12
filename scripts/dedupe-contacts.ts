/**
 * Remove duplicate company contacts left by the organisation-page job.
 *
 * maybeSingle() errors when a name is already present more than once, and that error read as
 * "not found", so every re-run inserted another copy. The route is fixed; this clears what it
 * wrote. The oldest row is kept, because found_at is the date we actually first read the name
 * off a page and a later copy would move it forward for no reason.
 *
 *   npx tsx --env-file=.env.local scripts/dedupe-contacts.ts            report
 *   npx tsx --env-file=.env.local scripts/dedupe-contacts.ts --write    delete the copies
 */
import { createClient } from '@supabase/supabase-js';

const write = process.argv.includes('--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const key = (c: any) => `${c.company_id}|${String(c.name ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}`;

(async () => {
  const { data, error } = await db.from('contacts')
    .select('id, company_id, lead_id, name, title, source_url, found_at')
    .not('company_id', 'is', null)
    .order('found_at', { ascending: true });
  if (error) { console.error(error.message); process.exit(1); }

  const seen = new Map<string, any>();
  const extra: any[] = [];
  for (const c of data ?? []) {
    const k = key(c);
    if (seen.has(k)) extra.push(c); else seen.set(k, c);
  }

  // A contact attached to a lead came from Radar, not from here, and is left alone — listing it
  // as a deletion would promise something this script does not do.
  const mine = extra.filter((c: any) => !c.lead_id);
  const theirs = extra.length - mine.length;
  console.log(`${(data ?? []).length} company contacts · ${seen.size} distinct · ${extra.length} duplicate${extra.length === 1 ? '' : 's'}`);
  console.log(`${mine.length} were written by this job and will be deleted; ${theirs} are attached to a lead and are left alone.`);
  for (const c of mine) console.log(`  drop ${c.name} (${c.title ?? 'no title'}) — keeping the copy from ${seen.get(key(c)).found_at?.slice(0, 10) ?? 'unknown'}`);

  if (!write) { console.log('\n(report only — pass --write to delete)'); return; }
  if (!extra.length) return;
  // Never touch a contact attached to a lead: those were created by a different path.
  const ids = mine.map((c) => c.id);
  const { error: del } = await db.from('contacts').delete().in('id', ids);
  console.log(del ? `could not delete: ${del.message}` : `deleted ${ids.length}`);
})();
