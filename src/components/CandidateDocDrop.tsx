'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { CertCard } from './CertCard';
import { friendlyError } from '@/lib/friendly-error';
import { candidateLabel } from '@/lib/candidate-number';
import { MismatchQuestion } from './MismatchQuestion';

/**
 * Drop certificates (or any document) on a candidate's page (item 24). The files go through Verify's intake with this
 * candidate named. A file attaches to them only when the name on it fits theirs; one that names someone else is stored
 * unattached and asked about here — attach anyway, or open a record for the person named (item 24 follow-up, 2026-09-15:
 * Paul Daniel Pascale's certificate went onto #9 unasked). Each certificate then goes to its issuing body through
 * Verify's lookup, exactly as a Verify drop does. The card shows the three layers as it arrives; the page
 * refreshes when everything has answered, so the certificate list, its expiry and Today's expiry line all read the same
 * stored verification.
 */
export function CandidateDocDrop({ candidateId, label }: { candidateId: string; label: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [files, setFiles] = useState<any[]>([]);
  // What this drop put on the candidate, once it is settled and the page has re-read: one line, while the certificate
  // itself shows in the list below. A result card stays only while it still needs something — a question, a file not
  // saved, an issuer check that failed (item 24 follow-up 3, step 4: the page returns to its normal state after a drop).
  const [added, setAdded] = useState<string[]>([]);

  const run = async (list: File[]) => {
    if (!list.length || busy) return;
    setErr(''); setFiles([]); setAdded([]);
    setBusy(`Reading ${list.length} file${list.length === 1 ? '' : 's'}…`);
    try {
      const fd = new FormData();
      for (const f of list) fd.append('files', f);
      fd.append('candidate_id', candidateId);
      const r = await fetch('/api/verify/intake', { method: 'POST', body: fd });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) throw new Error(j?.error ?? `the files could not be read (HTTP ${r.status})`);
      const got: any[] = [...(j.candidates ?? []).flatMap((c: any) => c.files ?? []), ...(j.loose ?? [])];
      setFiles([...got]);
      for (const f of got.filter((x) => x.kind === 'certificate' && x.documentId)) {
        setBusy(`Checking ${f.extracted?.cert_body?.toUpperCase() ?? 'the certificate'} with the issuer…`);
        try {
          const lr = await fetch('/api/verify/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document_id: f.documentId }) });
          const lj = await lr.json().catch(() => null);
          if (!lr.ok) f.lookupError = lj?.error ?? `HTTP ${lr.status}`; else Object.assign(f, lj);
        } catch (e: any) { f.lookupError = String(e?.message ?? e); }
        setFiles([...got]);
      }
      const settled = got.filter((x) => x.candidateId === candidateId && !x.lookupError);
      setAdded(settled.map(describe));
      setFiles(got.filter((x) => !settled.includes(x)));
      // The page re-reads what changed: the certificate in its list, the CV in its count, with no reload.
      router.refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(''); }
  };

  return (
    <div className="mb-3">
      <label
        data-candidate-doc-drop
        data-candidate-doc-busy={busy ? 'true' : 'false'}
        onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); run(Array.from(e.dataTransfer.files)); }}
        className={`block border-2 border-dashed rounded-card px-4 py-4 text-center cursor-pointer text-[13px] ${over ? 'border-tool-verify bg-soft-verify' : 'border-line bg-[#FAFBFC]'}`}
      >
        <b className="block font-semibold">Drop certificates for {label}</b>
        <span className="text-ink3 text-[12px]">{busy || 'Read, decoded and checked with the issuer · or click to choose'}</span>
        <input ref={input} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.docx,.txt" className="hidden" disabled={!!busy} onChange={(e) => { const l = Array.from(e.target.files ?? []); e.target.value = ''; run(l); }} />
      </label>
      {err && <div className="text-bad text-[13px] mt-2">{friendlyError(err, 'cv')}</div>}
      {added.length > 0 && !busy && (
        <div data-candidate-doc-added className="text-ok text-[13px] mt-2">✓ Added to {label}: {added.join(', ')} — {added.every((a) => a === 'CV') ? 'counted in the CV card' : 'now in the list below'}</div>
      )}
      {files.length > 0 && (
        <div className="grid gap-3 mt-3" data-candidate-doc-results>
          {files.map((f, i) => (
            <div key={i} data-candidate-doc-result={f.kind} className="border border-line rounded px-3 py-3">
              {f.kind === 'certificate' ? <CertCard res={f} busy={busy} />
                : f.kind === 'other' || f.kind === 'unreadable' ? <div className="text-[13px]"><b>Not saved</b> — {f.file}{f.why ? ` · ${friendlyError(f.why, 'cv')}` : ''}</div>
                  : <div className="text-[13px]"><b>Saved as {f.kind}</b> — {f.file}</div>}
              {f.mismatch && <DropMismatch f={f} onSettled={(how) => {
                // Attached here after all: it is in this candidate's list now. A record opened for someone else keeps its line.
                if (how === 'attached') { setFiles((now) => now.filter((x) => x !== f)); setAdded((now) => [...now, describe(f)]); }
                router.refresh();
              }} />}
              {f.lookupError && <div className="text-warn text-[12px] mt-1.5">The certificate was saved, but checking it with the issuer failed: {f.lookupError}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/** A dropped file names someone else: nothing is attached until the recruiter answers the question. */
function DropMismatch({ f, onSettled }: { f: any; onSettled: (how: 'attached' | 'created') => void }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ created: boolean; reference: string; id: string } | null>(null);
  const post = async (body: any, what: string) => {
    setBusy(what); setErr('');
    try {
      const r = await fetch('/api/verify/attach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentId: f.documentId, ...body }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error ?? `nothing was attached (HTTP ${r.status})`);
      setDone({ created: !!j.created, reference: j.candidate?.reference ?? '', id: j.candidate?.id ?? '' });
      onSettled(j.created ? 'created' : 'attached');
    } catch (e: any) { setErr(String(e?.message ?? e)); } finally { setBusy(''); }
  };
  if (!f.documentId) return <div className="text-bad text-[12px] mt-1.5">It names {f.mismatch.holder ?? 'nobody'}, and it could not be saved.</div>;
  if (done) {
    return (
      <div data-mismatch-done={done.created ? 'created' : 'attached'} className="text-ok text-[13px] mt-2">
        {done.created
          ? <>✓ Record opened — <Link href={`/app/candidates/${done.id}`} className="text-accent">{candidateLabel(done.reference)} · {f.mismatch.holder}</Link>, and the {f.kind === 'cv' ? 'CV' : f.kind} is on it</>
          : <>✓ Attached to {candidateLabel(done.reference)} anyway — recorded as attached after being told the names differ</>}
      </div>
    );
  }
  return (
    <>
      <MismatchQuestion mismatch={f.mismatch} type={f.kind} busy={busy}
        onAttachAnyway={() => post({ candidateId: f.mismatch.candidate.id, confirmMismatch: true, reason: 'dropped on their page' }, 'anyway')}
        onOpenRecord={() => post({ create: true }, 'new')} />
      {err && <div className="text-bad text-[12px] mt-1.5">{err}</div>}
    </>
  );
}

/** How a settled file reads in the "Added" line. */
function describe(f: any): string {
  if (f.kind === 'cv') return 'CV';
  if (f.kind === 'certificate') return `${String(f.extracted?.cert_body ?? '').toUpperCase() || 'a'} certificate`.trim();
  return String(f.kind ?? 'document');
}
