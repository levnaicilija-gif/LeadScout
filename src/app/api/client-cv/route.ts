import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';

/**
 * GET /api/client-cv?candidate_id=… → a short-lived signed URL for the latest client PDF.
 * RLS scopes anonymized_cvs to the recruiter's own workspace, so this cannot hand out
 * another workspace's candidate. A version that failed the PII check has no file at all.
 */
export async function GET(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const id = params.get('candidate_id');
  const wantsDownload = params.get('download') === '1';
  if (!id) return NextResponse.json({ error: 'candidate_id required' }, { status: 400 });

  const sb = supabaseServer();
  const { data: cv } = await sb
    .from('anonymized_cvs')
    .select('storage_path, pii_check_passed, version, generated_at, candidates(reference_code)')
    .eq('candidate_id', id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!cv) return NextResponse.json({ error: 'No anonymized CV for this candidate yet — drop the CV into Verify first.' }, { status: 404 });
  if (!cv.pii_check_passed || !cv.storage_path) {
    return NextResponse.json({ error: 'This client CV did not pass the PII check, so no PDF was written. Re-run the anonymizer after fixing the flagged text.' }, { status: 409 });
  }

  // download=1 names the file so it arrives as RFBT-P-0004.pdf, ready to attach to an email.
  const ref = (cv as any).candidates?.reference_code ?? 'client-cv';
  const { data, error } = await sb.storage.from('pdfs').createSignedUrl(cv.storage_path, 300, wantsDownload ? { download: `${ref}.pdf` } : undefined);
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'could not sign the file' }, { status: 500 });
  return NextResponse.json({ url: data.signedUrl, generatedAt: cv.generated_at, filename: `${ref}.pdf` });
}
