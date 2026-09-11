'use client';
import { useState } from 'react';

export type Stage = 'read' | 'anonymising' | 'bullets' | 'pdf' | 'done' | 'failed';

const STEPS: { key: Stage; label: string }[] = [
  { key: 'read', label: 'Read' },
  { key: 'anonymising', label: 'Anonymising' },
  { key: 'bullets', label: 'Bullets' },
  { key: 'pdf', label: 'PDF' },
];

/** Where the work has actually got to — never "done" while the next step is still running. */
export function Progress({ stage }: { stage: Stage }) {
  const order = STEPS.map((s) => s.key);
  const at = stage === 'done' ? STEPS.length : stage === 'failed' ? -1 : order.indexOf(stage);
  return (
    <div className="flex items-center gap-1.5 text-[12px] mt-1">
      {STEPS.map((s, i) => {
        const done = i < at || stage === 'done';
        const active = i === at && stage !== 'done' && stage !== 'failed';
        return (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className={`px-1.5 py-0.5 rounded ${done ? 'bg-oksoft text-ok' : active ? 'bg-accentsoft text-accent' : 'bg-line2 text-ink3'}`}>
              {done ? '✓ ' : active ? '· ' : ''}{s.label}
            </span>
            {i < STEPS.length - 1 && <span className="text-ink3">→</span>}
          </span>
        );
      })}
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="grid grid-cols-[120px_1fr] gap-y-1 py-1 border-t border-line2 text-[13px]"><span className="text-ink3">{k}</span><span>{v}</span></div>
);

/** The full anonymised record, laid out as the client PDF is — not a one-line summary. */
export function AnonymizedPreview({ x }: { x: any }) {
  const p = x.profile ?? {};
  const certs: any[] = x.certificates ?? [];
  const summary: string[] = x.summary ?? [];
  const bullets: string[] = x.bullets ?? [];
  const gaps: { from: string; to: string }[] = p.gaps ?? x.gaps ?? [];
  // An empty field that says "—" tells a recruiter nothing. Say what to do about it.
  const missing = (what: string) => <span className="text-warn">{what}</span>;
  return (
    <div className="border border-line rounded bg-[#FAFBFC] p-4 mt-3 text-[13px]">
      <div className="flex items-baseline justify-between border-b-2 border-ink pb-2 mb-2">
        <div>
          <b className="text-[15px]">{p.trade}</b>
          <div className="text-ink3 text-[12px]">Reference {x.candidate.reference_code} · full profile released on client confirmation</div>
        </div>
        <span className="w-7 h-7 rounded bg-rail text-white grid place-items-center font-bold text-[12px]">R</span>
      </div>

      {summary.length > 0 && (
        <div className="mb-2.5 text-[13.5px] leading-relaxed">
          {summary.map((line, i) => <p key={i} className="mb-0.5">{line}</p>)}
        </div>
      )}

      {bullets.length > 0 && <ul className="list-disc pl-5 mb-3">{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>}

      <b className="block mt-2">Certificates</b>
      {certs.length === 0 && (
        <div className="text-[13px]">
          {(p.certificates ?? []).length > 0
            ? <>Claimed on the CV, none verified yet: {(p.certificates ?? []).join('; ')} — <span className="text-warn">ask for copies</span></>
            : missing('None on file — ask the candidate what they hold')}
        </div>
      )}
      {certs.map((c, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto] gap-2 border-t border-line2 py-1">
          <span>{c.name}{c.number ? ` · ${c.number}` : ''}</span>
          <span className={c.result === 'valid' ? 'text-ok' : c.result === 'pending' ? 'text-warn' : 'text-bad'}>{c.result}{c.validUntil ? ` · to ${c.validUntil}` : ''}</span>
        </div>
      ))}

      <b className="block mt-3">Experience</b>
      {(p.projects ?? []).length === 0 && <div className="text-[13px]">{missing('No work history on file — ask the candidate')}</div>}
      {(p.projects ?? []).map((e: any, i: number) => (
        <div key={i} className="grid grid-cols-[70px_1fr_60px] gap-2 border-t border-line2 py-1">
          <span className="text-ink3">{e.years}</span>
          <span>
            {[e.type, e.country].filter(Boolean).join(', ')}
            {e.scope && <span className="block text-ink3 text-[12px]">{e.scope}</span>}
          </span>
          <span className="text-ink3">{e.rotation ?? 'not stated'}</span>
        </div>
      ))}

      {gaps.length > 0 && (
        <div className="mt-2 text-[12px] text-warn">
          Not accounted for on the CV: {gaps.map((g) => `${g.from}–${g.to}`).join(', ')} — asked at screening.
        </div>
      )}

      <b className="block mt-3">Profile</b>
      <Row k="Trades" v={(p.trades ?? []).join(', ') || p.trade || missing('not stated — confirm')} />
      <Row k="Skills" v={(p.skills ?? []).join(', ') || missing('none listed — ask the candidate')} />
      <Row k="Languages" v={(p.languages ?? []).join(', ') || missing('not stated — confirm on the call')} />
      <Row k="Availability" v={p.availability || x.availabilityFrom || missing('not stated — confirm, or take it from a contract')} />

      <div className="flex justify-between text-[11px] text-ink3 border-t border-line pt-2 mt-3">
        <span>Employer names, contact details and date of birth are removed from this version.</span>
        <span>Verify: /v/{x.candidate.reference_code.toLowerCase()}</span>
      </div>
    </div>
  );
}

/** Fetches a signed URL and saves it under the reference code. */
export function DownloadPdf({ candidateId, kind, label, disabled, senior }: { candidateId: string; kind: 'client' | 'internal'; label: string; disabled?: boolean; senior?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (kind === 'internal' && !senior) return null;

  const go = async () => {
    setBusy(true); setErr('');
    try {
      if (kind === 'internal') {
        // Streamed straight back, never stored — fetch it and hand the blob to the browser.
        const r = await fetch(`/api/internal-cv?candidate_id=${encodeURIComponent(candidateId)}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        const blob = await r.blob();
        const name = (r.headers.get('content-disposition') ?? '').match(/filename="([^"]+)"/)?.[1] ?? 'internal-cv.pdf';
        save(URL.createObjectURL(blob), name, true);
      } else {
        const r = await fetch(`/api/client-cv?candidate_id=${encodeURIComponent(candidateId)}&download=1`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        save(j.url, j.filename ?? 'client-cv.pdf', false);
      }
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    setBusy(false);
  };

  const save = (href: string, name: string, revoke: boolean) => {
    const a = document.createElement('a');
    a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 10000);
  };

  if (disabled) return <span className="btn opacity-50 cursor-not-allowed" title="Blocked by the PII check — no PDF was written">{label}</span>;
  return (<>
    <button className={`btn ${kind === 'internal' ? 'border-bad text-bad' : ''}`} onClick={go} disabled={busy}>{busy ? '…' : label}</button>
    {err && <span className="text-bad text-[12px] self-center">{err}</span>}
  </>);
}
