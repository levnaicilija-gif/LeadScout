/**
 * Take one document off the candidate it is attached to, keeping the document (src/lib/detach-document.ts).
 *
 *   npx tsx --env-file=.env.local scripts/detach-document.ts <document-id> "<reason>"            # report only
 *   npx tsx --env-file=.env.local scripts/detach-document.ts <document-id> "<reason>" --write    # take it off
 *
 * First used 2026-09-15 on the owner's instruction for Paul Daniel Pascale's FROSIO certificate (No. 10810), which was on
 * #9. The same function is behind the candidate page's "Remove from this candidate".
 */
import { createClient } from '@supabase/supabase-js';
import { detachDocument } from '../src/lib/detach-document';

const [id, reason] = [process.argv[2], process.argv[3]];
const write = process.argv.includes('--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  if (!id || !reason || reason === '--write') { console.error('usage: detach-document.ts <document-id> "<reason>" [--write]'); process.exit(1); }
  const r = await detachDocument(db, id, { reason, by: null, write });
  console.log(`${r.type ?? 'document'} ${r.certBody ?? ''} No. ${r.number ?? '—'} · holder "${r.holder ?? '—'}"${r.from ? ` · on ${r.from.label} (${r.from.name ?? 'no name'})` : ''}`);
  if (!r.ok) { console.error(`not done: ${r.error}`); process.exit(1); }
  console.log(`${r.from!.label} holds ${r.sameTypeBefore} ${r.type}(s) · file ${r.fileTo === r.fileFrom ? 'stays where it is' : `${r.fileFrom} → ${r.fileTo}`}`);
  if (!r.written) { console.log('\nreport only — run again with --write to take it off'); return; }
  console.log(`\ntaken off: ${r.from!.label} now holds ${r.sameTypeAfter} ${r.type}(s) (was ${r.sameTypeBefore}); the document is kept, attached to nobody, with its ${r.verifications} verification(s)`);
})();
