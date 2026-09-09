import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { runLookup, ADAPTERS } from '@/lib/verify/adapters';
import { loadCertBody, stateFor, issuerEmail, STATE_LABEL, type CertState } from '@/lib/verify/routes';
export const maxDuration = 120;

/**
 * STEP 2 of the certificate check: take the route the issuing body actually offers, and record
 * the state it reached.
 *
 * Separate from the upload because a register can be slow or need a hosted browser, and that
 * must not hold up showing the recruiter what the certificate says.
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
    const { data: ws } = await db.from('workspaces').select('name').eq('id', me.workspace_id).maybeSingle();
    const agency = ws?.name ?? 'RFBT Recruitment';
    const notes: string[] = [];

    const cb = await loadCertBody(db, me.workspace_id, ext.cert_body);
    if (!cb) {
      // An unknown body is a task for a senior, not a dead end.
      const { data: v } = await db.from('verifications').insert({
        document_id: doc.id, method: 'manual', result: 'not_supported', route: 'unsupported', state: 'unsupported',
        valid_until: ext.expiry ?? null,
        notes: `No confirmation route recorded for "${ext.cert_body ?? 'this body'}" — a senior can add one in cert_bodies.`,
      }).select().single();
      await db.from('documents').update({ cert_state: 'unsupported' }).eq('id', doc.id);
      return NextResponse.json({ verification: v, certBody: null, state: 'unsupported', stateLabel: STATE_LABEL.unsupported, addRouteTask: true });
    }

    // Welder qualifications: consistency with the test report now, issuer confirmation by email.
    if (cb.body === 'iso9606') {
      let state: CertState = 'pending_issuer';
      let result = 'pending';
      let note = `Checking with ${ext.issuer ?? cb.name} by email`;
      if (doc.candidate_id) {
        const { data: tr } = await db.from('documents').select('extracted').eq('candidate_id', doc.candidate_id).eq('type', 'test_report').order('uploaded_at', { ascending: false }).limit(1).maybeSingle();
        const t: any = tr?.extracted;
        if (t && t.number === ext.number && t.process === ext.process && (t.holder ?? '').toLowerCase() === (ext.holder ?? '').toLowerCase()) {
          state = 'consistent_with_test_report';
          result = 'consistent_with_test_report';
          note = 'Certificate and welder test report agree; issuer confirmation requested';
        }
      }
      const { data: v } = await db.from('verifications').insert({
        document_id: doc.id, method: state === 'pending_issuer' ? 'issuer_email' : 'test_report',
        result, route: cb.route, state, valid_until: ext.expiry ?? null, notes: note,
      }).select().single();
      await db.from('documents').update({ cert_state: state }).eq('id', doc.id);
      return NextResponse.json({
        verification: v, certBody: cb, state, stateLabel: STATE_LABEL[state],
        issuerEmailDraft: issuerEmail(ext.issuer ?? cb.name, cb.email, ext, agency),
        needsTestReport: state === 'pending_issuer',
      });
    }

    // Routes that never call an adapter: nobody but the holder can show us the record.
    if (cb.route === 'candidate_share' || (cb.route === 'issuer_email' && !ADAPTERS[cb.adapter ?? ''])) {
      const state: CertState = cb.route === 'candidate_share' ? 'awaiting_candidate_share' : 'pending_issuer';
      const { data: v } = await db.from('verifications').insert({
        document_id: doc.id, method: state === 'pending_issuer' ? 'issuer_email' : 'manual',
        result: state === 'pending_issuer' ? 'pending' : 'not_supported',
        route: cb.route, state, checked_where: cb.url, valid_until: ext.expiry ?? null, notes: cb.instructions,
      }).select().single();
      await db.from('documents').update({ cert_state: state }).eq('id', doc.id);
      return NextResponse.json({
        verification: v, certBody: cb, state, stateLabel: STATE_LABEL[state],
        issuerEmailDraft: state === 'pending_issuer' ? issuerEmail(cb.name, cb.email, ext, agency) : undefined,
      });
    }

    let dob = ext.dob;
    if (!dob && doc.candidate_id) {
      const { data: pp } = await db.from('documents').select('extracted').eq('candidate_id', doc.candidate_id).eq('type', 'passport').limit(1).maybeSingle();
      dob = (pp?.extracted as any)?.dob;
    }

    const r = await runLookup(cb.adapter ?? ext.cert_body ?? 'other', {
      number: ext.number, holder: ext.holder, issuer: ext.issuer,
      method: ext.method ?? ext.process, level: ext.level, credentialUrl: ext.credential_url, dob,
    });

    const state = stateFor(cb.route, r.result === 'not_found' || r.result === 'not_supported' ? null : r.result);

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
      document_id: doc.id, method: 'browser_lookup', checked_where: r.checkedWhere || cb.url, checked_at: r.checkedAt,
      result: r.result, route: cb.route, state, valid_until: r.validUntil ?? ext.expiry ?? null,
      holder_on_source: r.holderOnSource, screenshot_path: shot, source_rows: r.certificates ?? [],
      notes: [r.notes, ...notes].filter(Boolean).join(' · '),
    }).select().single();
    if (error) return NextResponse.json({ error: `could not save the verification: ${error.code} ${error.message}` }, { status: 500 });

    await db.from('documents').update({
      cert_state: state,
      status: r.result === 'valid' ? 'verified' : r.result === 'invalid' ? 'expired' : 'received',
    }).eq('id', doc.id);

    // A register that could not confirm still has an issuer who can.
    const draft = state === 'pending_issuer' || state === 'unsupported' ? issuerEmail(cb.name, cb.email, ext, agency) : undefined;

    return NextResponse.json({
      verification: v, certBody: cb, state, stateLabel: STATE_LABEL[state],
      warnings: notes, issuerEmailDraft: draft,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
