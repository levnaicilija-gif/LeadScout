import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { renderInternalCv, type InternalCvData } from '@/lib/pdf/render';
export const maxDuration = 120;

/**
 * GET /api/internal-cv?candidate_id=… → the full internal record as a PDF download.
 *
 * Seniors only, and never stored: it carries the candidate's name, phone, email and the
 * employers the client version strips, so it is rendered per request and streamed straight
 * back rather than left in a bucket where a signed URL could escape.
 */
export async function GET(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  if (me.role !== 'senior') return NextResponse.json({ error: 'The internal CV contains personal data and is available to senior recruiters only.' }, { status: 403 });

  const id = new URL(req.url).searchParams.get('candidate_id');
  if (!id) return NextResponse.json({ error: 'candidate_id required' }, { status: 400 });

  const db = supabaseAdmin();
  const { data: cand } = await db.from('candidates').select('*').eq('id', id).eq('workspace_id', me.workspace_id).maybeSingle();
  if (!cand) return NextResponse.json({ error: 'candidate not found in this workspace' }, { status: 404 });

  const { data: ws } = await db.from('workspaces').select('name').eq('id', me.workspace_id).maybeSingle();
  const { data: verified } = await db.from('verifications')
    .select('result, valid_until, checked_where, checked_at, documents!inner(candidate_id, cert_body, extracted)')
    .eq('documents.candidate_id', id);

  const p: any = cand.profile ?? {};
  const data: InternalCvData = {
    referenceCode: cand.reference_code,
    fullName: cand.full_name,
    trade: p.trade ?? 'Trade not stated',
    trades: p.trades ?? [],
    phone: cand.phone, email: cand.email, dob: p.pii?.dob ?? null,
    preparedOn: new Date().toISOString(),
    certificates: (verified ?? []).map((v: any) => ({
      name: [v.documents?.cert_body?.toUpperCase(), v.documents?.extracted?.level && `Level ${v.documents.extracted.level}`].filter(Boolean).join(' ') || 'Certificate',
      number: v.documents?.extracted?.number ?? null,
      checkedWhere: v.checked_where, checkedAt: v.checked_at, validUntil: v.valid_until, result: v.result,
    })),
    claimed: p.certificates_claimed ?? [],
    experience: (p.projects ?? []).map((x: any) => ({ years: x.years, what: [x.type, x.country].filter(Boolean).join(', '), employer: x.employer ?? null, rotation: x.rotation ?? null })),
    skills: p.skills ?? [], languages: p.languages ?? [], availability: p.availability ?? null,
    agencyLine: ws?.name ?? 'RFBT Recruitment',
  };

  // Releasing personal data is logged, like a client reveal is.
  await db.from('internal_downloads').insert({ workspace_id: me.workspace_id, candidate_id: id, downloaded_by: me.id });

  const pdf = await renderInternalCv(data);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${cand.reference_code}-INTERNAL.pdf"`,
      'cache-control': 'no-store',
    },
  });
}
