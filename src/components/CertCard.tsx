'use client';
import { useState } from 'react';
import { levelNote, expiryTone } from '@/lib/trade-cards';
import { STATE_LABEL, STATE_TONE, type CertState } from '@/lib/verify/routes';

const tone = (t: 'ok' | 'warn' | 'bad' | 'none') => (t === 'ok' ? 'text-ok' : t === 'warn' ? 'text-warn' : t === 'bad' ? 'text-bad' : 'text-ink2');

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[130px_1fr] gap-y-1.5 py-1.5 border-t border-line2 text-[13px]"><span className="text-ink3">{k}</span><span>{children}</span></div>
);

/**
 * What the certificate itself says, then — separately — how far confirming it has got.
 *
 * The two were previously conflated, so a perfectly readable FROSIO certificate showed as
 * "No online register for this body — manual check" and its level, dates and scope were
 * nowhere on the card. The document is evidence in its own right; confirmation is a second
 * question with its own answer.
 */
export function CertCard({ res, busy }: { res: any; busy?: string }) {
  const ext = res?.extracted ?? {};
  const ver = res?.verification;
  const state: CertState | undefined = res?.state ?? ver?.state;
  const note = levelNote(ext.cert_body, ext.level, ext.method);
  const exp = expiryTone(ver?.valid_until ?? ext.expiry);

  const title = [
    res?.certBody?.name?.replace(/ —.*$/, '') ?? ext.issuer ?? 'Certificate',
    ext.level ? `Level ${String(ext.level).replace(/^level\s*/i, '')}` : ext.method,
  ].filter(Boolean).join(' ');

  const validText = (ver?.valid_until ?? ext.expiry)
    ? `valid to ${new Date(ver?.valid_until ?? ext.expiry).toLocaleDateString('en-GB', { month: '2-digit', year: 'numeric' })}`
    : 'no expiry printed';

  const headline = res?.verdict?.result === 'needs_retake'
    ? `Retake needed: ${res.verdict.unreadable.join(', ')}`
    : ext.doc_type && ext.doc_type !== 'certificate'
      ? `Read as ${ext.doc_type} — saved`
      : `${title} · ${validText}${state ? ` · ${STATE_LABEL[state]}` : busy ? ' · confirming…' : ''}`;

  const dot = exp.tone === 'bad' ? 'bg-bad' : state ? (STATE_TONE[state] === 'ok' ? 'bg-ok' : STATE_TONE[state] === 'warn' ? 'bg-warn' : 'bg-bad') : 'bg-accent';

  return (
    <div className="bg-panel border border-line rounded p-4 mt-4">
      <div className="text-[17px] font-semibold flex items-center gap-2"><span className={`w-2.5 h-2.5 rounded-full ${dot}`} />{headline}</div>
      <div className="text-ink3 text-[12px]">{[ext.holder, ext.number && `No. ${ext.number}`].filter(Boolean).join(' · ') || 'holder not printed'}</div>

      <div className="mt-3">
        <div className="text-[12px] text-ink3 uppercase tracking-wide">What the document says</div>
        <Row k="Level / scope">
          {[ext.level && `Level ${String(ext.level).replace(/^level\s*/i, '')}`, ext.method, ext.scope].filter(Boolean).join(' · ') || '—'}
          {note && <div className="text-ink2 text-[12px] mt-0.5">{note.explains}</div>}
        </Row>
        <Row k="Issued">{ext.issued ?? '—'}</Row>
        <Row k="Valid until">
          <span className={tone(exp.tone)}>
            {ver?.valid_until ?? ext.expiry ?? '—'}
            {exp.days != null && (exp.days < 0 ? ` · expired ${Math.abs(exp.days)} days ago` : exp.days <= 90 ? ` · ${exp.days} days left` : '')}
          </span>
        </Row>
        <Row k="Covers">
          {note?.covers?.length
            ? note.covers.map((t) => <span key={t} className="inline-block text-[12px] px-1.5 py-0.5 rounded bg-line2 text-ink2 mr-1">{t}</span>)
            : <span className="text-ink3">not mapped to a trade yet</span>}
        </Row>
      </div>

      <div className="mt-3">
        <div className="text-[12px] text-ink3 uppercase tracking-wide">Confirmation</div>
        <Row k="Status">
          {state ? <span className={tone(STATE_TONE[state])}>{STATE_LABEL[state]}</span> : busy ? <span className="text-ink3">checking…</span> : <span className="text-ink3">not checked yet</span>}
          {res?.certBody?.instructions && <div className="text-ink2 text-[12px] mt-0.5">{res.certBody.instructions}</div>}
        </Row>
        <Row k="Checked where">{ver?.checked_where ? <a className="text-accent" href={ver.checked_where} target="_blank" rel="noopener">{ver.checked_where}</a> : '—'}</Row>
        <Row k="Checked">{ver?.checked_at ? new Date(ver.checked_at).toLocaleString() : '—'}</Row>
        {ver?.notes && <Row k="Notes">{ver.notes}</Row>}
        {res?.warnings?.length > 0 && <Row k="Warnings"><span className="text-warn">{res.warnings.join(' · ')}</span></Row>}
      </div>

      {res?.issuerEmailDraft && <IssuerEmail draft={res.issuerEmailDraft} verificationId={ver?.id} bodyName={res?.certBody?.name} />}
      {res?.needsTestReport && <div className="mt-3 border border-line rounded p-3 text-[13px] bg-[#FAFBFC]">
        <b>Upload the welder test report</b>
        <div className="text-ink2 mt-0.5">With the test report on file and matching on number, holder, process and position, this certificate can go in a client pack labelled “consistent with test report” while the issuer confirms.</div>
      </div>}
      {res?.addRouteTask && <div className="mt-3 text-[13px] text-warn">No confirmation route is recorded for this body yet — a senior can add one so the next certificate routes automatically.</div>}
      {res?.lookupError && <div className="mt-3 text-[13px] text-warn">The certificate was read and saved, but the confirmation step failed: {res.lookupError}</div>}
    </div>
  );
}

/**
 * The drafted verification email. Sends through Resend when it is configured, and otherwise
 * hands the recruiter a prefilled mail window and records that they sent it — Today counts
 * days from that stamp either way.
 */
function IssuerEmail({ draft, verificationId, bodyName }: { draft: any; verificationId?: string; bodyName?: string }) {
  const [state, setState] = useState<{ busy?: boolean; sent?: string; err?: string }>({});

  const post = async (payload: any) => {
    setState({ busy: true });
    try {
      const r = await fetch('/api/verify/issuer-email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verification_id: verificationId, ...payload }) });
      const j = await r.json();
      if (!r.ok) { setState({ err: j.error }); return; }
      setState({ sent: j.sent === 'resend' ? `Sent to ${j.to}` : 'Marked as sent' });
    } catch (e: any) { setState({ err: e?.message ?? String(e) }); }
  };

  const mailto = `mailto:${draft.to ?? ''}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;

  return (
    <div className="mt-3 border border-line rounded p-3 bg-[#FAFBFC] text-[13px]">
      <b>Checking with {bodyName?.replace(/ —.*$/, '') ?? 'the issuer'} — send the email</b>
      <div className="text-ink2 text-[12px] mt-0.5">{draft.to ? `To ${draft.to}` : 'No address on file for this body — add one in cert_bodies.'}</div>
      <details className="mt-2"><summary className="cursor-pointer text-accent">Read the draft</summary>
        <pre className="whitespace-pre-wrap bg-panel border border-line rounded p-3 mt-2">{draft.subject}{'\n\n'}{draft.body}</pre>
      </details>
      <div className="flex gap-2 mt-2 flex-wrap items-center">
        <button className="btn btn-primary" disabled={state.busy || !!state.sent} onClick={() => post({ subject: draft.subject, body: draft.body })}>{state.busy ? '…' : 'Send'}</button>
        <a className="btn" href={mailto} onClick={() => post({ mark_only: true })}>Open in email</a>
        {state.sent && <span className="text-ok">{state.sent}</span>}
        {state.err && <span className="text-warn">{state.err}</span>}
      </div>
    </div>
  );
}
