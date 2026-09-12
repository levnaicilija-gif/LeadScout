/**
 * Move stored documents off paths that carry a candidate's name.
 *
 * Every upload site used to build its key from the file the recruiter dropped, so object storage
 * holds keys like `…/cv/1757…-Bertescu_Dumitrel_CV_Final_Readable.pdf`. Internal, never served
 * to a client — but a name in a path turns up in logs, backups, bucket listings and signed URLs,
 * and none of those are places anyone thinks to look for one.
 *
 * The move is done one file at a time and the row is only re-pointed after the copy succeeds, so
 * a failure leaves the document readable at its old key rather than orphaning it.
 *
 *   npx tsx --env-file=.env.local scripts/rename-document-paths.ts            report
 *   npx tsx --env-file=.env.local scripts/rename-document-paths.ts --write    move them
 */
import { createClient } from '@supabase/supabase-js';
import { documentPath, pathLooksNamed } from '../src/lib/storage-path';

const write = process.argv.includes('--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  const { data: docs, error } = await db.from('documents')
    .select('id, workspace_id, candidate_id, type, storage_path')
    .not('storage_path', 'is', null);
  if (error) { console.error(error.message); process.exit(1); }

  const named = (docs ?? []).filter((d) => pathLooksNamed(d.storage_path));
  console.log(`${(docs ?? []).length} stored documents · ${named.length} on a path that still carries the original file name`);

  let moved = 0, failed = 0;
  for (const d of named) {
    // The old leaf is the original file name; it is used only to derive the new digest and
    // extension, and is never written anywhere.
    const leaf = d.storage_path.split('/').pop() as string;
    const next = documentPath({
      workspaceId: d.workspace_id, type: d.type, filename: leaf,
      candidateId: d.candidate_id,
    });
    if (next === d.storage_path) continue;

    console.log(`  ${d.storage_path}\n    -> ${next}`);
    if (!write) continue;

    const { error: mv } = await db.storage.from('documents').move(d.storage_path, next);
    if (mv) {
      // Already moved by an earlier partial run? Then the row just needs re-pointing.
      const { data: at } = await db.storage.from('documents').list(next.split('/').slice(0, -1).join('/'));
      const there = (at ?? []).some((f) => f.name === next.split('/').pop());
      if (!there) { console.log(`    could not move: ${mv.message}`); failed++; continue; }
    }
    const { error: upd } = await db.from('documents').update({ storage_path: next }).eq('id', d.id);
    if (upd) { console.log(`    moved but could not re-point the row: ${upd.message}`); failed++; continue; }
    moved++;
  }

  if (!write) { console.log('\n(report only — pass --write to move them)'); return; }
  console.log(`\nmoved ${moved}${failed ? `, ${failed} failed` : ''}`);
  const { data: after } = await db.from('documents').select('storage_path').not('storage_path', 'is', null);
  const left = (after ?? []).filter((d) => pathLooksNamed(d.storage_path)).length;
  console.log(left === 0 ? 'no stored document path carries a file name any more' : `${left} still do`);
  process.exit(left === 0 ? 0 : 1);
})();
