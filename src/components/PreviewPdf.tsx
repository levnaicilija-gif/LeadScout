'use client';
import { useState } from 'react';

/**
 * Opens the stored client PDF in a new tab via a short-lived signed URL.
 * Disabled when the PII check failed — in that case no file was ever written.
 */
export function PreviewPdf({ candidateId, disabled, label = 'Preview client PDF' }: { candidateId: string; disabled?: boolean; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const open = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/client-cv?candidate_id=${encodeURIComponent(candidateId)}`);
      const j = await r.json();
      if (!r.ok) setErr(j.error ?? 'Could not open the PDF');
      else window.open(j.url, '_blank', 'noopener');
    } catch (e: any) {
      setErr(e?.message ?? 'Could not open the PDF');
    }
    setBusy(false);
  };

  if (disabled) return <span className="btn opacity-50 cursor-not-allowed" title="Blocked by the PII check — no PDF was written">{label}</span>;
  return (<>
    <button className="btn btn-primary" onClick={open} disabled={busy}>{busy ? '…' : label}</button>
    {err && <span className="text-bad text-[12px] self-center">{err}</span>}
  </>);
}
