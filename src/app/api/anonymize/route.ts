import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { parseCv, anonymize, clientBullets, scoreAgainstJob, piiRegexHits, piiModelReview } from '@/lib/ai/documents';
import { claude, MODEL_EXTRACT } from '@/lib/ai/claude';
import { renderClientCv, clientCvText, clientCvAllowed, type ClientCvData } from '@/lib/pdf/render';
export const maxDuration = 120;

/** POST multipart: files[] (CVs), job? (text), lead_id?, campaign_id? → per CV: profile, anonymized, bullets, score; if >1 CV and job: ranking + recommendation. */
export async function POST(req: Request) {
  const me = await currentUser(); if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const sb = supabaseServer(); const form = await req.formData();
  const files = form.getAll('files') as File[]; const job = (form.get('job') as string | null) ?? undefined;
  const { data: ws } = await sb.from('workspaces').select('name').eq('id', me.workspace_id).maybeSingle();
  const results: any[] = [];
  for (const f of files) {
    const bytes = Buffer.from(await f.arrayBuffer());
    const text = await cvText(bytes, f.type);
    const profile = await parseCv(text);
    const anon = anonymize(profile);
    const code = (await sb.rpc('next_reference_code', { tc: profile.trade_code })).data as string;
    const { data: cand } = await sb.from('candidates').insert({ workspace_id: me.workspace_id, reference_code: code, trade_code: profile.trade_code, full_name: profile.full_name, phone: profile.pii.phone, email: profile.pii.email, trade: profile.trade, languages: profile.languages, profile, created_via: 'verify', created_by: me.id }).select().single();
    const path = `${me.workspace_id}/cv/${cand.id}-${f.name}`;
    await sb.storage.from('documents').upload(path, bytes, { contentType: f.type });
    await sb.from('documents').insert({ candidate_id: cand.id, type: 'cv', storage_path: path, extracted: { text: text.slice(0, 5000) }, uploaded_by: me.id });
    const { data: verified } = await sb.from('verifications').select('result, valid_until, checked_where, checked_at, documents!inner(candidate_id, cert_body)').eq('documents.candidate_id', cand.id);
    const crossCheck = { claimed: profile.certificates_claimed, verified: (verified ?? []).length };
    const { bullets } = await clientBullets(anon, verified ?? [], job);
    const score = job ? await scoreAgainstJob(anon, verified ?? [], job) : null;
    if (score) await sb.from('scores').insert({ candidate_id: cand.id, ...score });
    const slug = code.toLowerCase();

    // Build exactly what the client will see, then check THAT — not a summary of it.
    const employers = profile.projects.map((p) => p.employer ?? '').filter(Boolean);
    const pdfData = clientCvData(code, profile, anon, verified ?? [], bullets, slug, ws?.name);
    const clientText = clientCvText(pdfData);

    const regexHits = piiRegexHits(clientText, profile.full_name, employers);
    const review = await piiModelReview(clientText, clientCvAllowed(pdfData));
    const piiHits = [...regexHits, ...review.findings.map((f) => `${f.kind}: "${f.text}" — ${f.why}`)];
    const passed = piiHits.length === 0;

    // Guardrail: a client PDF that fails the PII check is never written to storage.
    let pdfPath: string | null = null;
    if (passed) {
      const pdf = await renderClientCv(pdfData);
      pdfPath = `${me.workspace_id}/client-cv/${cand.id}-${slug}.pdf`;
      await sb.storage.from('pdfs').upload(pdfPath, pdf, { contentType: 'application/pdf', upsert: true });
    }
    await sb.from('anonymized_cvs').insert({ candidate_id: cand.id, public_slug: slug, storage_path: pdfPath, bullets, certs_cross_check: crossCheck, pii_check_passed: passed });
    results.push({ candidate: { id: cand.id, reference_code: code }, profile: anon, removed: ['name', 'phone', 'email', 'address', 'photo', 'date of birth', 'employer names'], bullets, crossCheck, piiHits, piiPassed: passed, pdfPath, score });
  }
  let recommendation: string | null = null;
  if (job && results.length > 1) {
    const ranked = [...results].sort((a, b) => (a.score?.blockers.length ? 1 : 0) - (b.score?.blockers.length ? 1 : 0) || (b.score?.score ?? 0) - (a.score?.score ?? 0));
    const r = await claude.messages.create({ model: MODEL_EXTRACT, max_tokens: 400, messages: [{ role: 'user', content: `Job:\n${job}\n\nRanked candidates (reference, score, fits, missing, blockers):\n${ranked.map((x) => `${x.candidate.reference_code}: ${x.score?.score} | fits ${x.score?.fits.join('; ')} | missing ${x.score?.missing.join('; ')} | blockers ${x.score?.blockers.join('; ') || 'none'}`).join('\n')}\n\nWrite a 3-5 sentence recommendation: which to send as a pack and why, what to ask the client before sending, who to hold and for what, who is not eligible. Use reference codes only.` }] });
    recommendation = r.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
    return NextResponse.json({ results: ranked, recommendation });
  }
  return NextResponse.json({ results, recommendation });
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
    trade: profile.trade,
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

async function cvText(bytes: Buffer, type: string) {
  if (type === 'text/plain') return bytes.toString('utf8');
  // PDF/DOCX/image → let Claude read it directly (vision/document). Simpler than a parser zoo; swap for pdf-parse/mammoth if volume grows.
  const r = await claude.messages.create({ model: MODEL_EXTRACT, max_tokens: 4000, messages: [{ role: 'user', content: [{ type: type === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: type as any, data: bytes.toString('base64') } } as any, { type: 'text', text: 'Transcribe this CV as plain text, preserving structure. Output text only.' }] }] });
  return r.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
}
