import type { SupabaseClient } from '@supabase/supabase-js';
import { candidateLabel } from './candidate-number';
import { hasAttachTrail } from './schema-features';

/**
 * Take a document off the candidate it is attached to, and keep the document (item 24 follow-up, 2026-09-15).
 *
 * The document, its reading and its verifications stay; only the link goes, so it is back among Verify's unattached
 * documents, ready to be attached to the right record. Its stored file moves out of that candidate's folder
 * (`…/<candidate id>/<digest>.<ext>` → `…/unattached/<digest>.<ext>`, see storage-path.ts), so nothing that later clears the
 * candidate's files can take it. The attach trail records when, by whom and why.
 *
 * Refused when the document is the one that settles the candidate's right to work: detaching it would leave their
 * right-to-work answer pointing at evidence they no longer hold.
 *
 * Written for Paul Daniel Pascale's FROSIO certificate, dropped on #9's page on 2026-09-15 and attached with no name check.
 */
export type DetachReport = {
  ok: boolean; error?: string;
  documentId: string; type?: string; certBody?: string | null; holder?: string | null; number?: string | null;
  from?: { candidateId: string; label: string; name: string | null };
  sameTypeBefore?: number; sameTypeAfter?: number; verifications?: number;
  fileFrom?: string | null; fileTo?: string | null; written: boolean;
};

export async function detachDocument(
  db: SupabaseClient,
  documentId: string,
  opts: { reason: string; by: string | null; workspaceId?: string; write: boolean },
): Promise<DetachReport> {
  const report: DetachReport = { ok: false, documentId, written: false };
  const { data: doc, error } = await db.from('documents')
    .select('id, type, cert_body, candidate_id, storage_path, workspace_id, holder:extracted->>holder, number:extracted->>number')
    .eq('id', documentId).maybeSingle();
  if (error || !doc) return { ...report, error: error ? `the document could not be read: ${error.message}` : 'no such document' };
  if (opts.workspaceId && doc.workspace_id !== opts.workspaceId) return { ...report, error: 'no such document' };
  Object.assign(report, { type: doc.type, certBody: doc.cert_body, holder: doc.holder, number: doc.number, fileFrom: doc.storage_path });
  if (!doc.candidate_id) return { ...report, error: 'this document is not attached to anyone' };

  const { data: cand, error: cErr } = await db.from('candidates')
    .select('id, reference_code, full_name, eu_passport_document_id, uk_right_to_work_document_id').eq('id', doc.candidate_id).maybeSingle();
  if (cErr || !cand) return { ...report, error: `the candidate it is on could not be read${cErr ? `: ${cErr.message}` : ''}` };
  report.from = { candidateId: cand.id, label: candidateLabel(cand.reference_code), name: cand.full_name ?? null };
  if ([cand.eu_passport_document_id, cand.uk_right_to_work_document_id].includes(doc.id)) {
    return { ...report, error: `this document settles ${report.from.label}'s right to work, so it cannot be taken off them here` };
  }

  const sameType = async () => (await db.from('documents').select('id', { count: 'exact', head: true }).eq('candidate_id', cand.id).eq('type', doc.type)).count ?? 0;
  report.sameTypeBefore = await sameType();
  const folder = `/${cand.id}/`;
  report.fileTo = doc.storage_path?.includes(folder) ? doc.storage_path.replace(folder, '/unattached/') : doc.storage_path;
  if (!opts.write) return { ...report, ok: true };

  const moving = !!doc.storage_path && report.fileTo !== doc.storage_path;
  if (moving) {
    const { error: mv } = await db.storage.from('documents').move(doc.storage_path, report.fileTo!);
    if (mv) return { ...report, error: `the stored file could not be moved, so nothing was changed: ${mv.message}` };
  }
  const patch: Record<string, unknown> = { candidate_id: null, ...(moving ? { storage_path: report.fileTo } : {}) };
  if (await hasAttachTrail(db)) {
    Object.assign(patch, { attached_by: opts.by, attached_at: new Date().toISOString(), attach_reason: `taken off ${report.from.label}: ${opts.reason}`.slice(0, 400) });
  }
  const { error: upd } = await db.from('documents').update(patch).eq('id', doc.id).eq('candidate_id', cand.id);
  if (upd) {
    if (moving) await db.storage.from('documents').move(report.fileTo!, doc.storage_path);
    return { ...report, error: `not taken off: ${upd.message}` };
  }
  report.written = true;
  report.sameTypeAfter = await sameType();
  report.verifications = (await db.from('verifications').select('id', { count: 'exact', head: true }).eq('document_id', doc.id)).count ?? 0;
  return { ...report, ok: true };
}
