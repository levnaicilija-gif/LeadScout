/**
 * Fill documents.content_sha256 for files stored before 0044.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-document-hashes.ts           # report only
 *   npx tsx --env-file=.env.local scripts/backfill-document-hashes.ts --write
 *
 * Re-reads each stored object and hashes the bytes. Report-only by default, resumable, and it only
 * ever fills a NULL — a row that already carries a hash is never touched, so a second run writes
 * nothing. No model call, no cost.
 *
 * A null hash means "never hashed", never "different from everything" (document-hash.ts), so leaving
 * rows unfilled is safe: they simply do not participate in the same-file check until they are.
 */
import { createClient } from '@supabase/supabase-js';
import { contentHash } from '../src/lib/document-hash';

const write = process.argv.includes('--write');
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  const { data: probe, error: probeError } = await admin.from('documents').select('content_sha256').limit(1);
  if (probeError) {
    console.error(`documents.content_sha256 cannot be read — has 0044 been applied? ${probeError.message}`);
    process.exitCode = 1;
    return;
  }
  void probe;

  const { data, error } = await admin.from('documents')
    .select('id, storage_path, type, candidate_id')
    .is('content_sha256', null)
    .order('id');
  if (error) { console.error(`could not list the documents: ${error.message}`); process.exitCode = 1; return; }

  const rows = data ?? [];
  console.log(`${rows.length} document(s) with no hash${write ? '' : ' — report only, pass --write to fill them'}\n`);

  let filled = 0;
  const problems: string[] = [];
  const seen = new Map<string, string[]>();

  for (const d of rows) {
    const { data: blob, error: dlError } = await admin.storage.from('documents').download(d.storage_path);
    if (dlError || !blob) { problems.push(`${d.id}: could not read ${d.storage_path} — ${dlError?.message ?? 'no body'}`); continue; }
    const hash = contentHash(Buffer.from(await blob.arrayBuffer()));
    seen.set(hash, [...(seen.get(hash) ?? []), d.id]);

    if (!write) { console.log(`  would fill ${d.id}  ${d.type}  ${hash.slice(0, 16)}…`); continue; }
    const { error: upError } = await admin.from('documents').update({ content_sha256: hash }).eq('id', d.id);
    if (upError) { problems.push(`${d.id}: could not store the hash — ${upError.message}`); continue; }
    filled++;
    console.log(`  filled ${d.id}  ${d.type}  ${hash.slice(0, 16)}…`);
  }

  // What the hash is FOR: say which stored files turn out to be the same bytes.
  const dupes = [...seen.entries()].filter(([, ids]) => ids.length > 1);
  console.log(`\n${write ? `filled ${filled}` : `would fill ${rows.length - problems.length}`}, ${problems.length} problem(s)`);
  if (dupes.length) {
    console.log(`\nfiles stored more than once (the same bytes under different rows):`);
    for (const [hash, ids] of dupes) console.log(`  ${hash.slice(0, 16)}…  ${ids.length} rows: ${ids.join(', ')}`);
  } else {
    console.log('no two stored files have the same bytes.');
  }
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  process.exitCode = problems.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
