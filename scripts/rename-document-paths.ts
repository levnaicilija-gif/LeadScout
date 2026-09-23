/**
 * Move every stored document onto a path keyed by its OWN ID.
 *
 *   npx tsx --env-file=.env.local scripts/rename-document-paths.ts            report
 *   npx tsx --env-file=.env.local scripts/rename-document-paths.ts --write    move them
 *
 * ONE SCRIPT, ONE RULE. This began on 2026-09-13 as "move stored documents off paths that carry a
 * candidate's name", and that pass is done. It now targets the wider rule that replaced it: a path's
 * leaf must be the document's own id. Anything else — the original file name, or the digest of that
 * name which succeeded it — is moved. Generalised rather than duplicated, because two scripts that
 * both rewrite storage keys would drift, and the one that drifted would be the one nobody ran.
 *
 * WHY, in one line: the digest was of the FILE NAME, so two different files called `CV.pdf` resolved
 * to the same key and `upsert: true` destroyed the first. See storage-path.ts for the full account
 * and for the three rows whose objects it already destroyed.
 *
 * TWO ROWS CAN SHARE ONE OBJECT TODAY — that is the bug, sitting in the data. A plain `move` would
 * re-point the first row and leave the second addressing nothing, so a shared object is COPIED to
 * each new path and the original removed only after every copy has succeeded. A row whose object is
 * already gone is reported and left exactly as it is: those rows are the evidence this happened
 * (owner's decision, 2026-09-23) and there is nothing to move.
 *
 * The row is re-pointed only after its object is confirmed at the new key, so a failure leaves the
 * document readable where it was rather than orphaning it. Re-runnable: a row already on its id path
 * is skipped, so a second run moves nothing.
 */
import { createClient } from '@supabase/supabase-js';
import { documentPath } from '../src/lib/storage-path';

const write = process.argv.includes('--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const leafOf = (p: string) => p.split('/').pop() ?? '';
const folderOf = (p: string) => p.split('/').slice(0, -1).join('/');

/** Is the object really at this key? `remove()` and `move()` both answer about paths, not objects. */
async function objectAt(path: string): Promise<boolean> {
  const { data } = await db.storage.from('documents').list(folderOf(path));
  return (data ?? []).some((f) => f.name === leafOf(path));
}

(async () => {
  const { data: docs, error } = await db.from('documents')
    .select('id, storage_path, type, candidate_id, workspace_id')
    .order('id');
  if (error) { console.error(`could not read the documents: ${error.message}`); process.exitCode = 1; return; }
  const rows = docs ?? [];

  // How many rows address each stored object — the shared ones need copying, not moving.
  const sharers = new Map<string, number>();
  for (const d of rows) sharers.set(d.storage_path, (sharers.get(d.storage_path) ?? 0) + 1);

  const todo = rows.filter((d) => {
    const ext = leafOf(d.storage_path).split('.').pop() ?? 'bin';
    return leafOf(d.storage_path) !== `${d.id}.${ext}`;
  });

  console.log(`${rows.length} stored documents · ${todo.length} not yet on an id path · ${[...sharers.values()].filter((n) => n > 1).length} object(s) addressed by more than one row`);
  if (!write) console.log('report only — pass --write to move them\n');

  let moved = 0, copied = 0, missing = 0, failed = 0;
  const removeAfter = new Map<string, number>();   // old path -> copies still owed before it may go

  for (const d of todo) {
    const ext = leafOf(d.storage_path).split('.').pop() ?? 'bin';
    const next = documentPath({
      workspaceId: d.workspace_id, type: d.type, documentId: d.id,
      filename: `x.${ext}`, candidateId: d.candidate_id,
    });
    const shared = (sharers.get(d.storage_path) ?? 1) > 1;

    if (!(await objectAt(d.storage_path))) {
      missing++;
      console.log(`  MISSING  ${d.id.slice(0, 8)}  ${d.storage_path}\n           its object is already gone — row left exactly as it is`);
      continue;
    }

    console.log(`  ${shared ? 'COPY' : 'MOVE'}     ${d.id.slice(0, 8)}  ${d.storage_path}\n           -> ${next}`);
    if (!write) continue;

    if (shared) {
      const { error: cp } = await db.storage.from('documents').copy(d.storage_path, next);
      if (cp && !(await objectAt(next))) { failed++; console.log(`           FAILED to copy: ${cp.message}`); continue; }
      removeAfter.set(d.storage_path, (removeAfter.get(d.storage_path) ?? sharers.get(d.storage_path)!) - 1);
      copied++;
    } else {
      const { error: mv } = await db.storage.from('documents').move(d.storage_path, next);
      // An earlier partial run may already have moved it; then the row just needs re-pointing.
      if (mv && !(await objectAt(next))) { failed++; console.log(`           FAILED to move: ${mv.message}`); continue; }
      moved++;
    }

    const { error: up } = await db.from('documents').update({ storage_path: next }).eq('id', d.id);
    if (up) { failed++; console.log(`           MOVED BUT NOT RE-POINTED: ${up.message} — the file is at the new key and the row still says the old one`); }
  }

  // Only once every row that shared an object has its own copy.
  for (const [path, owed] of removeAfter) {
    if (owed > 0) { console.log(`  kept ${path} — ${owed} row(s) still to copy`); continue; }
    const { error: rm } = await db.storage.from('documents').remove([path]);
    console.log(rm ? `  could not remove the shared original ${path}: ${rm.message}` : `  removed the shared original ${path}`);
  }

  console.log(`\n${write ? `moved ${moved}, copied ${copied}` : `would move/copy ${todo.length - missing}`}, ${missing} already gone, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
