import { NextResponse } from 'next/server';
import { supabaseServer, supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { hasTable } from '@/lib/schema-features';
import { detachDocument } from '@/lib/detach-document';
import { candidateLabel } from '@/lib/candidate-number';
import { removeFiles } from '@/lib/candidate-deletion';

/**
 * A document on a candidate: taken off them, or deleted — two different things, kept apart (item 24 follow-up 3, step 8).
 *
 *   POST   { action: 'detach' }    Remove from this candidate. Nothing is lost: the file, its reading and its issuer check
 *                                  stay, attached to nobody, ready to go on the right person from Verify
 *                                  (detach-document.ts, the same function that took Paul Daniel Pascale's certificate off
 *                                  #9). Any recruiter in the workspace.
 *   DELETE { confirm: 'delete' }   Delete permanently — for a duplicate upload or a genuine mistake. The file, its issuer
 *                                  screenshot, its reading and its issuer check are erased. A senior's action (owner's
 *                                  decision, 2026-09-15), recorded in deletion_log before anything is removed (0037).
 *
 * SENSITIVE PERSONAL DATA: the document is read with the signed-in user's client first, so row-level security decides
 * whether they can see it at all, and it must be on this candidate.
 */
type Params = { params: { id: string; docId: string } };

async function theirDocument({ params }: Params) {
  const me = await currentUser();
  if (!me) return { fail: NextResponse.json({ error: 'unauthorised' }, { status: 401 }) };
  const { data: doc, error } = await supabaseServer().from('documents')
    .select('id, type, cert_body, candidate_id, workspace_id, storage_path, candidates!candidate_id(reference_code, eu_passport_document_id, uk_right_to_work_document_id)')
    .eq('id', params.docId).maybeSingle() as { data: any; error: any };
  if (error) return { fail: NextResponse.json({ error: `the document could not be read: ${error.message}` }, { status: 500 }) };
  if (!doc || doc.candidate_id !== params.id || doc.workspace_id !== me.workspace_id) return { fail: NextResponse.json({ error: 'no such document on this candidate' }, { status: 404 }) };
  return { me, doc };
}

export async function POST(req: Request, ctx: Params) {
  const got = await theirDocument(ctx);
  if (got.fail) return got.fail;
  const b = await req.json().catch(() => ({}));
  if (b.action !== 'detach') return NextResponse.json({ error: "send { action: 'detach' } to remove it from this candidate" }, { status: 400 });
  const r = await detachDocument(supabaseAdmin(), got.doc.id, {
    reason: String(b.reason ?? 'removed from this candidate on their page').slice(0, 200), by: got.me!.id, workspaceId: got.me!.workspace_id, write: true,
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
  return NextResponse.json({ ok: true, removedFrom: r.from?.label, kept: true, verificationsKept: r.verifications });
}

export async function DELETE(req: Request, ctx: Params) {
  const got = await theirDocument(ctx);
  if (got.fail) return got.fail;
  const { me, doc } = got as { me: any; doc: any };
  if (me.role !== 'senior') return NextResponse.json({ error: 'Only a senior can delete a document permanently. To take it off the wrong person, remove it from this candidate instead — nothing is lost.' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  if (String(b.confirm ?? '').trim().toLowerCase() !== 'delete') return NextResponse.json({ error: 'type delete to confirm' }, { status: 400 });
  const db = supabaseAdmin();
  if (!(await hasTable(db, 'deletion_log'))) return NextResponse.json({ error: 'Deleting permanently arrives with migration 0037, which is not applied yet.' }, { status: 409 });
  if ([doc.candidates?.eu_passport_document_id, doc.candidates?.uk_right_to_work_document_id].includes(doc.id)) {
    return NextResponse.json({ error: "This document settles the candidate's right to work, so it cannot be deleted here." }, { status: 409 });
  }

  const label = candidateLabel(doc.candidates?.reference_code);
  // On record before anything is erased; no name — the type, the issuing body and the candidate's number.
  const { data: log, error: logError } = await db.from('deletion_log').insert({
    workspace_id: me.workspace_id, kind: 'document', subject_id: doc.id, subject_ref: `${doc.type}${doc.cert_body ? ` ${doc.cert_body}` : ''} on ${label}`, deleted_by: me.id,
  }).select('id').single();
  if (logError || !log) return NextResponse.json({ error: `The deletion could not be recorded, so nothing was deleted: ${logError?.message ?? 'no log row'}` }, { status: 500 });
  // The closing write IS the audit record. Its result is read: a deletion that happened and was not recorded is the one
  // thing this log exists to prevent, so a lost write is reported rather than swallowed (the error column is untrimmed).
  const finish = async (patch: Record<string, unknown>) => {
    const { error } = await db.from('deletion_log').update(patch).eq('id', log.id);
    return error?.message ?? null;
  };

  const { count: verifications, error: vErr } = await db.from('verifications').select('id', { count: 'exact', head: true }).eq('document_id', doc.id);
  if (vErr) { await finish({ error: `verifications could not be counted: ${vErr.message}` }); return NextResponse.json({ error: `nothing was deleted: ${vErr.message}` }, { status: 500 }); }
  const files = await removeFiles(db, [{ bucket: 'documents', paths: [doc.storage_path] }, { bucket: 'screenshots', paths: [`${me.workspace_id}/verify/${doc.id}.png`] }]);
  if (files.error) { await finish({ error: files.error }); return NextResponse.json({ error: `The file could not be erased, so the document was kept: ${files.error}` }, { status: 500 }); }
  // Verifications go with the document (on delete cascade); cert_unknown keeps its row and loses the example (set null).
  const { error: delError, count } = await db.from('documents').delete({ count: 'exact' }).eq('id', doc.id);
  if (delError || count !== 1) {
    await finish({ error: `file erased, row not deleted: ${delError?.message ?? `${count} rows`}`, removed: { files: files.removed } });
    return NextResponse.json({ error: `The file was erased but the record was not deleted: ${delError?.message ?? `${count} rows`}` }, { status: 500 });
  }
  const removed = { rows: { documents: 1, verifications: verifications ?? 0 }, files: files.removed };
  const notRecorded = await finish({ completed_at: new Date().toISOString(), removed });
  if (notRecorded) return NextResponse.json({ error: `It was deleted, but the deletion could not be recorded: ${notRecorded}`, removed }, { status: 500 });
  return NextResponse.json({ ok: true, removed });
}
