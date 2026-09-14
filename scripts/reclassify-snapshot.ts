/**
 * The companies whose careers-page classification failed with "too_big", before and after they are read again.
 *
 *   npx tsx --env-file=.env.local scripts/reclassify-snapshot.ts before   writes .cache/reclassify-before.json
 *   npx tsx --env-file=.env.local scripts/reclassify-snapshot.ts after    compares against it
 *
 * The set is fixed by the before file: a company that is read again no longer carries the failure text, so it could
 * not be found by it afterwards.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';

const mode = process.argv[2];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const COLS = 'id, name, employer_type, employer_type_override, employer_type_source, employer_type_reason, employer_type_evidence, employer_type_checked_at, careers_url';
const s = (v: any) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

(async () => {
  if (mode === 'before') {
    const all: any[] = [];
    for (let f = 0; ; f += 1000) {
      const { data, error } = await db.from('companies').select(COLS).order('id').range(f, f + 999);
      if (error) throw new Error(error.message);
      if (!data?.length) break; all.push(...data); if (data.length < 1000) break;
    }
    const set = all.filter((c) => /could not be read: \[/.test(s(c.employer_type_evidence)));
    writeFileSync('.cache/reclassify-before.json', JSON.stringify(set, null, 1));
    const by = (k: string) => set.filter((c) => (c.employer_type ?? 'unknown') === k).length;
    console.log(`${set.length} companies · queued (checked_at null): ${set.filter((c) => !c.employer_type_checked_at).length} · unknown ${by('unknown')} · with a name guess ${set.length - by('unknown')}`);
    console.log(set.filter((c) => c.employer_type && c.employer_type !== 'unknown').map((c) => `${c.name}=${c.employer_type}/${c.employer_type_source}`).join(', '));
    return;
  }
  const before: any[] = JSON.parse(readFileSync('.cache/reclassify-before.json', 'utf8'));
  const { data, error } = await db.from('companies').select(COLS).in('id', before.map((c) => c.id));
  if (error) throw new Error(error.message);
  const now = new Map((data ?? []).map((c: any) => [c.id, c]));
  const rows = before.map((b) => ({ b, a: now.get(b.id) }));
  const read = rows.filter((r) => r.a?.employer_type_source === 'careers_page');
  const stillFailed = rows.filter((r) => r.a && /could not be read/.test(s(r.a.employer_type_evidence)) && r.a.employer_type_checked_at);
  const pending = rows.filter((r) => r.a && !r.a.employer_type_checked_at);
  const changed = read.filter((r) => (r.a.employer_type ?? 'unknown') !== (r.b.employer_type ?? 'unknown'));
  const nowKnown = read.filter((r) => r.a.employer_type && r.a.employer_type !== 'unknown');
  console.log(`of ${before.length}: read from the careers page ${read.length} · a type now known ${nowKnown.length} · type changed ${changed.length} · failed again ${stillFailed.length} · not yet read ${pending.length} · gone ${rows.filter((r) => !r.a).length}`);
  for (const r of rows) {
    const a = r.a;
    if (!a) { console.log(`  ${r.b.name}: row gone`); continue; }
    const ev = s(a.employer_type_evidence).replace(/\s+/g, ' ').slice(0, 160);
    console.log(`  ${r.b.name}: ${r.b.employer_type ?? 'unknown'}/${r.b.employer_type_source ?? '—'} → ${a.employer_type ?? 'unknown'}/${a.employer_type_source ?? '—'}${a.employer_type_checked_at ? '' : ' (not yet read)'} · ${ev}`);
  }
  const hiring = ['StS gruppen', 'Kemp & Lauritzen', 'Baker Hughes', 'Yabimo Norge AS', 'EnBW Offshore Wind Norway'];
  console.log('\nnamed: ' + hiring.map((n) => { const r = rows.find((x) => x.b.name === n); return r ? `${n} ${r.b.employer_type ?? 'unknown'} → ${r.a?.employer_type ?? 'gone'} (${r.a?.employer_type_source ?? '—'})` : `${n} not in the set`; }).join(' | '));
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
