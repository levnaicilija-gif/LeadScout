'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { CertCard } from './CertCard';
import { friendlyError } from '@/lib/friendly-error';

/**
 * Drop certificates (or any document) on a candidate's page (item 24). The files go through Verify's intake with this
 * candidate named, so they attach to them — no name matching decides it — and each certificate then goes to its issuing
 * body through Verify's lookup, exactly as a Verify drop does. The card shows the three layers as it arrives; the page
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

  const run = async (list: File[]) => {
    if (!list.length || busy) return;
    setErr(''); setFiles([]);
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
      {files.length > 0 && (
        <div className="grid gap-3 mt-3" data-candidate-doc-results>
          {files.map((f, i) => (
            <div key={i} data-candidate-doc-result={f.kind} className="border border-line rounded px-3 py-3">
              {f.kind === 'certificate' ? <CertCard res={f} busy={busy} />
                : f.kind === 'other' || f.kind === 'unreadable' ? <div className="text-[13px]"><b>Not saved</b> — {f.file}{f.why ? ` · ${friendlyError(f.why, 'cv')}` : ''}</div>
                  : <div className="text-[13px]"><b>Saved as {f.kind}</b> — {f.file}</div>}
              {f.holderNote && <div className="text-warn text-[12px] mt-1.5" data-holder-note>{f.holderNote}</div>}
              {f.lookupError && <div className="text-warn text-[12px] mt-1.5">The certificate was saved, but checking it with the issuer failed: {f.lookupError}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
