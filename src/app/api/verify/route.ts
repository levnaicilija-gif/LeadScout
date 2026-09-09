import { NextResponse } from 'next/server';
import { supabaseServer, supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { extractDocument } from '@/lib/ai/documents';
import { ISSUER_EMAIL_BODIES } from '@/lib/verify/adapters';
import { fileToBase64 } from '@/lib/files';
export const maxDuration = 120;

/**
 * STEP 1 of the certificate check: read the document and store it. Nothing that talks to an
 * issuer happens here.
 *
 * The register lookup used to run in this same request, which meant one call did a vision
 * extraction, a storage upload, several inserts AND a browser session against an issuer — and
 * on a slow register it simply never came back. The lookup now lives in /api/verify/lookup,
 * so the recruiter sees what was read off the certificate within seconds and the slow part
 * reports separately.
 *
 * Writes go through the service role. The user is authenticated first and every row is scoped
 * to their own workspace explicitly; RLS still governs what they can read back (migration 0007).
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const candidateId = (form.get('candidate_id') as string | null) || null;
    if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 });

    const bytes = Buffer.from(await file.arrayBuffer());
    const { base64, mediaType, kind } = await fileToBase64(bytes, file.type, file.name);
    if (kind === 'unsupported') {
      return NextResponse.json({ error: `Cannot read ${file.name}. Upload a PDF, JPG, PNG or DOCX.` }, { status: 415 });
    }

    const ext = await extractDocument(base64, mediaType);

    const db = supabaseAdmin();
    const path = `${me.workspace_id}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
    const up = await db.storage.from('documents').upload(path, bytes, { contentType: file.type || mediaType, upsert: true });
    if (up.error) return NextResponse.json({ error: `could not store the file: ${up.error.message}` }, { status: 500 });

    const { data: doc, error: dErr } = await db.from('documents').insert({
      workspace_id: me.workspace_id, candidate_id: candidateId, type: ext.doc_type, cert_body: ext.cert_body,
      storage_path: path, extracted: ext, uploaded_by: me.id,
      status: ext.unreadable.length ? 'needs_retake' : 'received',
    }).select().single();
    if (dErr) return NextResponse.json({ error: `could not save the document: ${dErr.code} ${dErr.message}` }, { status: 500 });

    // What happens next, decided here so the client does not have to know the rules.
    const next =
      ext.doc_type !== 'certificate' ? null
        : ext.unreadable.length ? null
          : ISSUER_EMAIL_BODIES.has(ext.cert_body ?? '') ? 'issuer_email'
            : 'lookup';

    return NextResponse.json({
      document: doc,
      extracted: ext,
      next,
      verdict: ext.unreadable.length ? { result: 'needs_retake', unreadable: ext.unreadable } : undefined,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}

/** Kept so a recruiter can re-read a stored document without re-uploading it. */
export async function GET(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const id = new URL(req.url).searchParams.get('document_id');
  if (!id) return NextResponse.json({ error: 'document_id required' }, { status: 400 });
  const sb = supabaseServer();
  const { data } = await sb.from('documents').select('*').eq('id', id).maybeSingle();
  return NextResponse.json({ document: data });
}
