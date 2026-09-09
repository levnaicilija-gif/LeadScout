import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { anonymize, clientBullets, scoreAgainstJob, piiRegexHits, piiModelReview } from '@/lib/ai/documents';
import { renderClientCv, clientCvText, clientCvAllowed, type ClientCvData } from '@/lib/pdf/render';
export const maxDuration = 120;

/**
 * STEP 2 of the CV anonymizer, one candidate at a time: the three client bullets, the job
 * score, both PII gates and the client PDF.
 *
 * One candidate per request keeps every call well inside the function budget no matter how
 * many CVs were dropped at once.
 *
 *   POST { candidate_id, job? }
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  try {
    const { candidate_id: candidateId, job } = await req.json();
    if (!candidateId) return NextResponse.json({ error: 'candidate_id required' }, { status: 400 });

    const db = supabaseAdmin();
    const { data: cand } = await db.from('candidates').select('*').eq('id', candidateId).eq('workspace_id', me.workspace_id).maybeSingle();
    if (!cand) return NextResponse.json({ error: 'candidate not found in this workspace' }, { status: 404 });

    const profile: any = cand.profile ?? {};
    const anon = anonymize(profile);
    const code = cand.reference_code as string;
    const slug = code.toLowerCase();

    const { data: ws } = await db.from('workspaces').select('name').eq('id', me.workspace_id).maybeSingle();
    const { data: verified } = await db.from('verifications')
      .select('result, valid_until, checked_where, checked_at, documents!inner(candidate_id, cert_body, extracted)')
      .eq('documents.candidate_id', candidateId);

    const bullets = (await clientBullets(anon, verified ?? [], job)).bullets;
    const score = job ? await scoreAgainstJob(anon, verified ?? [], job) : null;
    if (score) await db.from('scores').insert({ candidate_id: candidateId, ...score });

    const pdfData = clientCvData(code, profile, anon, verified ?? [], bullets, slug, ws?.name);
    const clientText = clientCvText(pdfData);
    const employers = (profile.projects ?? []).map((p: any) => p.employer ?? '').filter(Boolean);

    const regexHits = piiRegexHits(clientText, profile.full_name, employers);
    const review = await piiModelReview(clientText, clientCvAllowed(pdfData));
    const piiHits = [...regexHits, ...review.findings.map((f) => `${f.kind}: "${f.text}" — ${f.why}`)];
    const passed = piiHits.length === 0;

    // Guardrail: a client PDF that fails the PII check is never written to storage.
    let pdfPath: string | null = null;
    if (passed) {
      const pdf = await renderClientCv(pdfData);
      pdfPath = `${me.workspace_id}/client-cv/${candidateId}-${slug}.pdf`;
      const up = await db.storage.from('pdfs').upload(pdfPath, pdf, { contentType: 'application/pdf', upsert: true });
      if (up.error) return NextResponse.json({ error: `could not store the PDF: ${up.error.message}` }, { status: 500 });
    }

    await db.from('anonymized_cvs').insert({
      candidate_id: candidateId, public_slug: slug, storage_path: pdfPath, bullets,
      certs_cross_check: { claimed: profile.certificates_claimed ?? [], verified: (verified ?? []).length },
      pii_check_passed: passed,
    });

    return NextResponse.json({
      candidate: { id: candidateId, reference_code: code },
      bullets, score, piiHits, piiPassed: passed, pdfPath,
      crossCheck: { claimed: (profile.certificates_claimed ?? []).length, verified: (verified ?? []).length },
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}

/** Shapes the anonymised profile for the PDF. Employer names never reach it — anonymize() drops them. */
function clientCvData(code: string, profile: any, anon: any, verified: any[], bullets: string[], slug: string, agency?: string): ClientCvData {
  const certs = verified.map((v: any) => ({
    name: [v.documents?.cert_body?.toUpperCase(), v.documents?.extracted?.level && `Level ${v.documents.extracted.level}`].filter(Boolean).join(' ') || 'Certificate',
    number: v.documents?.extracted?.number ?? null,
    checkedWhere: v.checked_where ?? null,
    checkedAt: v.checked_at ?? null,
    validUntil: v.valid_until ?? null,
    result: v.result,
  }));
  return {
    referenceCode: code,
    trade: profile.trade ?? 'Trade not stated',
    preparedOn: new Date().toISOString(),
    bullets,
    certificates: certs,
    experience: (anon.projects ?? []).map((p: any) => ({ years: p.years, what: [p.type, p.country].filter(Boolean).join(', '), rotation: p.rotation ?? null })),
    skills: anon.skills ?? [],
    languages: anon.languages ?? [],
    availability: anon.availability ?? null,
    publicUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/v/${slug}`.replace(/^https?:\/\//, ''),
    agencyLine: agency ?? 'RFBT Recruitment',
  };
}
