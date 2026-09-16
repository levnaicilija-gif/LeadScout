'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { normName } from '@/lib/name-match';

/**
 * Delete a candidate and everything tied to them, permanently (item 24 follow-up 3, step 7). SENSITIVE PERSONAL DATA.
 *
 * A senior's action (owner's decision, 2026-09-15), in two steps: "Delete candidate…" opens a box that says exactly what
 * goes, and the delete button stays disabled until the candidate's name is typed (their number when no name is on file).
 * The route checks both again. A record that this number was deleted, by whom and when, is kept — without the name.
 */
export type WhatGoes = { cvs: number; certificates: number; otherDocuments: number; sends: number; placements: number; clientVersions: number };

export function DeleteCandidate({ candidateId, label, name, goes, senior, ready }: { candidateId: string; label: string; name: string | null; goes: WhatGoes; senior: boolean; ready: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const byName = !!name?.trim();
  const confirmed = byName ? normName(typed) !== '' && normName(typed) === normName(name) : typed.trim() === label;
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const list = [
    count(goes.cvs, 'CV'), count(goes.certificates, 'certificate'), goes.otherDocuments ? count(goes.otherDocuments, 'other document') : '',
    count(goes.sends, 'CV-sent entry', 'CV-sent entries'), count(goes.placements, 'placement'), goes.clientVersions ? count(goes.clientVersions, 'client version') : '',
  ].filter(Boolean).join(', ');

  const remove = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/candidates/${candidateId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: typed }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error ?? `nothing was deleted (HTTP ${r.status})`);
      router.push(`/app/candidates?deleted=${encodeURIComponent(label)}`);
      router.refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setBusy(false);
    }
  };

  if (!senior || !ready) {
    return (
      <div data-delete-candidate={!senior ? 'not-senior' : 'not-ready'} className="text-[13px] flex flex-wrap items-center gap-3">
        <button type="button" className="btn text-[13px]" disabled title={!senior ? 'Only a senior can delete a candidate' : 'Arrives with migration 0037'}>Delete candidate…</button>
        <span className="text-ink3">{!senior ? 'Only a senior can delete a candidate.' : 'Deleting a candidate arrives with migration 0037, which is not applied yet.'}</span>
      </div>
    );
  }
  if (!open) {
    return <button type="button" data-delete-candidate-open onClick={() => setOpen(true)} className="btn text-[13px] text-bad border-bad">Delete candidate…</button>;
  }
  return (
    <div data-delete-candidate-box className="border border-bad bg-badsoft rounded-card p-3 text-[13px] grid gap-2">
      <b className="font-semibold text-bad">Permanently delete {label}{byName ? ` · ${name}` : ''}?</b>
      <div className="text-ink2">Their record and everything tied to them are <b>erased and cannot be recovered</b>: {list}. The files themselves are erased from storage too. A record that {label} was deleted — by you, now — is kept, without their name.</div>
      <label className="grid gap-1">
        <span className="text-ink2">Type {byName ? 'their name' : 'their number'} to confirm: <b>{byName ? name : label}</b></span>
        <input data-delete-candidate-input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="border border-line rounded px-3 py-2 bg-panel min-w-0" />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-delete-candidate-confirm disabled={!confirmed || busy} onClick={remove} className="btn btn-danger disabled:opacity-50">{busy ? 'Deleting…' : 'Delete permanently'}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => { setOpen(false); setTyped(''); setErr(''); }}>Cancel</button>
      </div>
      {err && <div className="text-bad text-[12px]" data-delete-candidate-error>{err}</div>}
    </div>
  );
}
