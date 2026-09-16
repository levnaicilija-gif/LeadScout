'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The two ways a certificate leaves a candidate's page, deliberately unlike each other (item 24 follow-up 3, step 8):
 *
 *   Remove from this candidate — nothing is lost. For a certificate on the wrong person (Paul Daniel Pascale's on #9): it
 *   stays, attached to nobody, and can be attached to the right record from Verify. Any recruiter.
 *   Delete permanently — erased, not recoverable. For a duplicate upload or a genuine mistake. A senior's, confirmed by
 *   typing "delete", and recorded in the deletion log.
 *
 * The two open different boxes with different words and colours, so detaching the wrong person's certificate cannot end in
 * deleting a real document.
 */
export function CertificateActions({ candidateId, documentId, label, senior, ready }: { candidateId: string; documentId: string; label: string; senior: boolean; ready: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<'' | 'remove' | 'delete'>('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const call = async (method: 'POST' | 'DELETE', body: Record<string, unknown>) => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/candidates/${candidateId}/documents/${documentId}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error ?? `nothing was changed (HTTP ${r.status})`);
      setMode('');
      router.refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(false); }
  };
  const deleteWhy = !senior ? 'Only a senior can delete a document permanently' : !ready ? 'Deleting permanently arrives with migration 0037' : '';

  return (
    <div data-cert-actions={documentId} className="mt-2 text-[13px]">
      {mode === '' && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <button type="button" data-cert-remove className="text-accent" onClick={() => setMode('remove')}>Remove from this candidate</button>
          <button type="button" data-cert-delete disabled={!!deleteWhy} title={deleteWhy || undefined} onClick={() => { setTyped(''); setMode('delete'); }}
            className="text-bad disabled:text-ink3 disabled:cursor-not-allowed">Delete permanently</button>
          {deleteWhy && <span className="text-ink3 text-[12px]" data-cert-delete-why>{deleteWhy}.</span>}
        </div>
      )}

      {mode === 'remove' && (
        <div data-cert-remove-box className="border border-line rounded-card p-3 bg-[#FAFBFC] grid gap-2">
          <b className="font-semibold">Remove this certificate from {label}?</b>
          <div className="text-ink2">It is <b>not deleted</b>. The file, its reading and its issuer check are kept, attached to nobody, and it can be attached to the right person from Verify&apos;s unattached documents.</div>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-cert-remove-confirm disabled={busy} onClick={() => call('POST', { action: 'detach' })} className="btn btn-primary disabled:opacity-60">{busy ? 'Removing…' : `Remove from ${label}`}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setMode('')}>Cancel</button>
          </div>
        </div>
      )}

      {mode === 'delete' && (
        <div data-cert-delete-box className="border border-bad bg-badsoft rounded-card p-3 grid gap-2">
          <b className="font-semibold text-bad">Delete this certificate permanently?</b>
          <div className="text-ink2">The file, its reading and its issuer check are <b>erased and cannot be recovered</b>. This is for a duplicate upload or a genuine mistake — if it is only on the wrong person, cancel and use Remove from this candidate instead.</div>
          <label className="grid gap-1">
            <span className="text-ink2">Type <b>delete</b> to confirm</span>
            <input data-cert-delete-input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="border border-line rounded px-3 py-2 bg-panel min-w-0" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-cert-delete-confirm disabled={busy || typed.trim().toLowerCase() !== 'delete'} onClick={() => call('DELETE', { confirm: typed })}
              className="btn btn-danger disabled:opacity-50">{busy ? 'Deleting…' : 'Delete permanently'}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setMode('')}>Cancel</button>
          </div>
        </div>
      )}

      {err && <div className="text-bad text-[12px] mt-1.5" data-cert-action-error>{err}</div>}
    </div>
  );
}
