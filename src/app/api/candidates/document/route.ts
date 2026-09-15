import { NextResponse } from 'next/server';
import { supabaseServer, supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { candidateLabel } from '@/lib/candidate-number';

/**
 * A candidate's original uploaded file — a CV or a certificate as the candidate sent it (item 24). SENSITIVE PERSONAL
 * DATA: the document row is read with the signed-in user's client first, so row-level security decides whether they may
 * see it at all; only then does the service role sign a link to the stored object, valid for 60 seconds.
 *
 *   GET ?id=<document id>             → 302 to the file, for viewing (an iframe or an image)
 *   GET ?id=<document id>&download=1  → 302 to the file as a download
 *
 * The download's filename is the candidate number and the document type — "candidate-4-certificate.pdf" — never a name:
 * a name in a filename turns up in download folders, logs and email attachments (CLAUDE.md, storage paths).
 */
export async function GET(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const id = p.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { data: doc, error } = await supabaseServer().from('documents').select('id, type, storage_path, candidates!candidate_id(reference_code)').eq('id', id).maybeSingle() as { data: any; error: any };
  if (error) return NextResponse.json({ error: `the document could not be read: ${error.message}` }, { status: 500 });
  if (!doc) return NextResponse.json({ error: 'no such document in your workspace' }, { status: 404 });

  const ext = (String(doc.storage_path).match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? 'bin').toLowerCase();
  const number = candidateLabel(doc.candidates?.reference_code).replace(/^#/, '');
  const filename = `candidate-${number || 'unassigned'}-${doc.type}.${ext}`;
  const { data: signed, error: signError } = await supabaseAdmin().storage.from('documents').createSignedUrl(doc.storage_path, 60, p.get('download') ? { download: filename } : undefined);
  if (signError || !signed?.signedUrl) return NextResponse.json({ error: `the file could not be opened: ${signError?.message ?? 'no link'}` }, { status: 500 });
  return NextResponse.redirect(signed.signedUrl, 302);
}
