import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { extractDocument } from '@/lib/ai/documents';
import { runLookup, ISSUER_EMAIL_BODIES } from '@/lib/verify/adapters';
export const maxDuration = 120;

/** POST multipart: file, candidate_id? , campaign_end? → extract → lookup → store. Recruiter-initiated only. */
export async function POST(req: Request) {
  const me = await currentUser(); if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const form = await req.formData();
  const file = form.get('file') as File; const candidateId = form.get('candidate_id') as string | null; const campaignEnd = form.get('campaign_end') as string | null;
  if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 });
  const sb = supabaseServer();
  const bytes = Buffer.from(await file.arrayBuffer());
  const ext = await extractDocument(bytes.toString('base64'), file.type || 'application/pdf');

  const path = `${me.workspace_id}/${Date.now()}-${file.name}`;
  await sb.storage.from('documents').upload(path, bytes, { contentType: file.type });
  const { data: doc } = await sb.from('documents').insert({ candidate_id: candidateId, type: ext.doc_type, cert_body: ext.cert_body, storage_path: path, extracted: ext, uploaded_by: me.id, status: ext.unreadable.length ? 'needs_retake' : 'received' }).select().single();

  if (ext.doc_type !== 'certificate') return NextResponse.json({ document: doc, extracted: ext });
  if (ext.unreadable.length) return NextResponse.json({ document: doc, extracted: ext, verdict: { result: 'needs_retake', unreadable: ext.unreadable } });

  // Welder certs: no public register. Test-report consistency now, issuer email in parallel.
  if (ISSUER_EMAIL_BODIES.has(ext.cert_body ?? '')) {
    let result: string = 'pending'; let notes = `Checking with ${ext.issuer ?? 'issuer'} by email`;
    if (candidateId) {
      const { data: tr } = await sb.from('documents').select('extracted').eq('candidate_id', candidateId).eq('type', 'test_report').order('uploaded_at', { ascending: false }).limit(1).maybeSingle();
      const t: any = tr?.extracted;
      if (t && t.number === ext.number && t.process === ext.process && (t.holder ?? '').toLowerCase() === (ext.holder ?? '').toLowerCase()) { result = 'consistent_with_test_report'; notes = 'Certificate and welder test report agree; issuer confirmation requested'; }
    }
    const { data: v } = await sb.from('verifications').insert({ document_id: doc.id, method: result === 'pending' ? 'issuer_email' : 'test_report', result, valid_until: ext.expiry, notes }).select().single();
    return NextResponse.json({ document: doc, extracted: ext, verification: v, issuerEmailDraft: issuerEmail(ext) });
  }

  const r = await runLookup(ext.cert_body ?? 'other', { number: ext.number, holder: ext.holder, issuer: ext.issuer });
  let shot: string | null = null;
  if (r.screenshot) { shot = `verify/${doc.id}.png`; await sb.storage.from('screenshots').upload(shot, r.screenshot, { contentType: 'image/png' }); }
  const notes: string[] = [];
  if (candidateId) {
    const { data: pp } = await sb.from('documents').select('extracted').eq('candidate_id', candidateId).eq('type', 'passport').limit(1).maybeSingle();
    const pn = (pp?.extracted as any)?.holder; if (pn && ext.holder && pn.toLowerCase() !== ext.holder.toLowerCase()) notes.push(`Holder mismatch: cert "${ext.holder}" vs passport "${pn}"`);
  }
  if (campaignEnd && r.validUntil && new Date(r.validUntil) < new Date(campaignEnd)) notes.push(`Expires before project end ${campaignEnd}`);
  const { data: v } = await sb.from('verifications').insert({ document_id: doc.id, method: 'browser_lookup', checked_where: r.checkedWhere, checked_at: r.checkedAt, result: r.result, valid_until: r.validUntil ?? ext.expiry, holder_on_source: r.holderOnSource, screenshot_path: shot, notes: [r.notes, ...notes].filter(Boolean).join(' · ') }).select().single();
  await sb.from('documents').update({ status: r.result === 'valid' ? 'verified' : r.result === 'invalid' ? 'expired' : 'received' }).eq('id', doc.id);
  return NextResponse.json({ document: doc, extracted: ext, verification: v, warnings: notes });
}
const issuerEmail = (e: any) => ({ subject: `Verification request — welder qualification ${e.number ?? ''}`, body: `Dear certification office,\n\nPlease confirm the validity of the following welder qualification issued by ${e.issuer ?? 'your office'}:\n\nCertificate number: ${e.number ?? ''}\nHolder: ${e.holder ?? ''}\nProcess / position: ${e.process ?? ''} ${e.position ?? ''}\nIssued: ${e.issued ?? ''} · Expiry: ${e.expiry ?? ''}\n\nA copy is attached. Kind regards,\nRFBT Recruitment` });
