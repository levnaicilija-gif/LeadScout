import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { runLookup, ISSUER_EMAIL_BODIES } from '@/lib/verify/adapters';
export const maxDuration = 120;

/**
 * STEP 2 of the certificate check: ask the issuer's register, and record what it said.
 *
 * Separate from the upload on purpose — a register can be slow or need a hosted browser, and
 * that must not hold up showing the recruiter what the certificate says.
 *
 *   POST { document_id, campaign_end? }
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  try {
    const { document_id: documentId, campaign_end: campaignEnd } = await req.json();
    if (!documentId) return NextResponse.json({ error: 'document_id required' }, { status: 400 });

    const db = supabaseAdmin();
    const { data: doc } = await db.from('documents').select('*').eq('id', documentId).eq('workspace_id', me.workspace_id).maybeSingle();
    if (!doc) return NextResponse.json({ error: 'document not found in this workspace' }, { status: 404 });

    const ext: any = doc.extracted ?? {};
    const notes: string[] = [];

    // Welder qualifications have no public register: consistency with the test report now,
    // issuer confirmation by email in parallel.
    if (ISSUER_EMAIL_BODIES.has(ext.cert_body ?? '')) {
      let result = 'pending';
      let note = `Checking with ${ext.issuer ?? 'the issuer'} by email`;
      if (doc.candidate_id) {
        const { data: tr } = await db.from('documents').select('extracted').eq('candidate_id', doc.candidate_id).eq('type', 'test_report').order('uploaded_at', { ascending: false }).limit(1).maybeSingle();
        const t: any = tr?.extracted;
        if (t && t.number === ext.number && t.process === ext.process && (t.holder ?? '').toLowerCase() === (ext.holder ?? '').toLowerCase()) {
          result = 'consistent_with_test_report';
          note = 'Certificate and welder test report agree; issuer confirmation requested';
        }
      }
      const { data: v } = await db.from('verifications').insert({
        document_id: doc.id, method: result === 'pending' ? 'issuer_email' : 'test_report',
        result, valid_until: ext.expiry ?? null, notes: note,
      }).select().single();
      return NextResponse.json({ verification: v, issuerEmailDraft: issuerEmail(ext) });
    }

    let dob = ext.dob;
    if (!dob && doc.candidate_id) {
      const { data: pp } = await db.from('documents').select('extracted').eq('candidate_id', doc.candidate_id).eq('type', 'passport').limit(1).maybeSingle();
      dob = (pp?.extracted as any)?.dob;
    }

    const r = await runLookup(ext.cert_body ?? 'other', {
      number: ext.number, holder: ext.holder, issuer: ext.issuer,
      method: ext.method ?? ext.process, level: ext.level, credentialUrl: ext.credential_url, dob,
    });

    let shot: string | null = null;
    if (r.screenshot) {
      shot = `${me.workspace_id}/verify/${doc.id}.png`;
      await db.storage.from('screenshots').upload(shot, r.screenshot, { contentType: 'image/png', upsert: true });
    }

    if (doc.candidate_id) {
      const { data: pp } = await db.from('documents').select('extracted').eq('candidate_id', doc.candidate_id).eq('type', 'passport').limit(1).maybeSingle();
      const pn = (pp?.extracted as any)?.holder;
      if (pn && ext.holder && pn.toLowerCase() !== ext.holder.toLowerCase()) notes.push(`Holder mismatch: cert "${ext.holder}" vs passport "${pn}"`);
    }
    if (campaignEnd && r.validUntil && new Date(r.validUntil) < new Date(campaignEnd)) notes.push(`Expires before project end ${campaignEnd}`);
    if (r.holderOnSource && ext.holder && r.holderOnSource.toLowerCase().replace(/\s+/g, ' ') !== ext.holder.toLowerCase().replace(/\s+/g, ' ')) {
      notes.push(`Holder on register "${r.holderOnSource}" differs from certificate "${ext.holder}"`);
    }
    const matched = r.certificates?.find((c) => (c.number ?? '').toLowerCase().replace(/\s+/g, '') === (ext.number ?? '').toLowerCase().replace(/\s+/g, ''));
    if (matched?.level && ext.level && !String(ext.level).toLowerCase().includes(matched.level.toLowerCase())) {
      notes.push(`Level on register "${matched.level}" differs from certificate "${ext.level}"`);
    }

    const { data: v, error } = await db.from('verifications').insert({
      document_id: doc.id, method: 'browser_lookup', checked_where: r.checkedWhere, checked_at: r.checkedAt,
      result: r.result, valid_until: r.validUntil ?? ext.expiry ?? null, holder_on_source: r.holderOnSource,
      screenshot_path: shot, source_rows: r.certificates ?? [], notes: [r.notes, ...notes].filter(Boolean).join(' · '),
    }).select().single();
    if (error) return NextResponse.json({ error: `could not save the verification: ${error.code} ${error.message}` }, { status: 500 });

    await db.from('documents').update({ status: r.result === 'valid' ? 'verified' : r.result === 'invalid' ? 'expired' : 'received' }).eq('id', doc.id);
    return NextResponse.json({ verification: v, warnings: notes });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}

const issuerEmail = (e: any) => ({
  subject: `Verification request — welder qualification ${e.number ?? ''}`,
  body: `Dear certification office,\n\nPlease confirm the validity of the following welder qualification issued by ${e.issuer ?? 'your office'}:\n\nCertificate number: ${e.number ?? ''}\nHolder: ${e.holder ?? ''}\nProcess / position: ${e.process ?? ''} ${e.position ?? ''}\nIssued: ${e.issued ?? ''} · Expiry: ${e.expiry ?? ''}\n\nA copy is attached. Kind regards,\nRFBT Recruitment`,
});
