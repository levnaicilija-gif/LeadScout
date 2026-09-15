'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AttachChoice } from './AttachChoice';
import { candidateLabel } from '@/lib/candidate-number';
import { friendlyError } from '@/lib/friendly-error';

/**
 * Add a candidate from any screen (item 24): drag CV files anywhere onto the app, or press "Add CV".
 *
 * It is Verify's intake, unchanged in what it reads — the same document recognition and CV parsing — and the same
 * duplicate rule: a name plus a second field. A new person becomes a record; someone who looks like a person already in
 * the pool is stored and asked about, never merged; anything that is not a candidate document is not saved. The
 * anonymised client version is not made here — that is an action on the candidate's page.
 *
 * Verify keeps its own drop zone (which also runs the client version and questions), so the overlay stands aside there,
 * and on onboarding. Touch screens cannot drag files, so the button is always shown.
 */
const TIMEOUT_MS = 150_000;

export function CandidateDrop() {
  const pathname = usePathname() ?? '';
  const standAside = pathname.startsWith('/app/verify') || pathname.startsWith('/app/onboarding');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState<any | null>(null);
  const [open, setOpen] = useState(false);
  const busyRef = useRef(false);
  const depth = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  const run = async (files: File[]) => {
    if (!files.length || busyRef.current) return;
    busyRef.current = true;
    setOpen(true); setErr(''); setResult(null);
    setBusy(`Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      const r = await fetch('/api/verify/intake', { method: 'POST', body: fd, signal: ac.signal });
      const text = await r.text();
      let j: any = null;
      try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!r.ok || !j) throw new Error(j?.error ?? `the files could not be read (HTTP ${r.status})`);
      setResult(j);
    } catch (e: any) {
      setErr(e?.name === 'AbortError' ? `took longer than ${TIMEOUT_MS / 1000}s and was stopped` : String(e?.message ?? e));
    } finally {
      clearTimeout(timer);
      busyRef.current = false;
      setBusy('');
    }
  };

  useEffect(() => {
    if (standAside) return;
    const withFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => { if (!withFiles(e)) return; e.preventDefault(); depth.current++; setDragging(true); };
    const over = (e: DragEvent) => { if (!withFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const leave = (e: DragEvent) => { if (!withFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragging(false); };
    const drop = (e: DragEvent) => {
      if (!withFiles(e)) return;
      e.preventDefault();
      depth.current = 0; setDragging(false);
      run(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [standAside]);

  if (standAside) return null;

  const created = (result?.candidates ?? []).filter((c: any) => (c.files ?? []).some((f: any) => f.kind === 'cv'));
  const attachedElsewhere = (result?.candidates ?? []).filter((c: any) => !(c.files ?? []).some((f: any) => f.kind === 'cv'));
  const loose = result?.loose ?? [];

  return (
    <>
      <input ref={input} data-candidate-drop-input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.docx,.txt" className="hidden"
        onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; run(files); }} />

      <button type="button" data-candidate-drop-button onClick={() => (result || err || busy ? setOpen(!open) : input.current?.click())}
        className="fixed z-40 right-4 bottom-4 btn btn-primary shadow-lg flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
        {busy ? 'Reading…' : result || err ? (open ? 'Hide' : 'Added') : 'Add CV'}
      </button>

      {dragging && (
        <div data-candidate-drop-overlay className="fixed inset-0 z-50 bg-rail/70 grid place-items-center px-4 pointer-events-none">
          <div className="w-full max-w-[520px] border-2 border-dashed border-white rounded-tile px-6 py-12 text-center text-white">
            <b className="block font-display text-[22px] font-bold">Drop CVs to add candidates</b>
            <div className="text-[13px] mt-1.5 text-railink">Read the same way Verify reads them · someone already in the pool is asked about, never merged</div>
          </div>
        </div>
      )}

      {open && (busy || err || result) && (
        <div data-candidate-drop-panel data-candidate-drop-busy={busy ? 'true' : 'false'}
          className="fixed z-40 right-4 bottom-[72px] w-[min(440px,calc(100vw-32px))] max-h-[70vh] overflow-auto bg-panel border border-line rounded-card shadow-xl">
          <div className="flex items-center justify-between px-4 py-3 border-b border-line">
            <b className="font-semibold">Add candidates</b>
            <div className="flex gap-2">
              {!busy && <button type="button" className="btn text-[13px] py-1.5" onClick={() => input.current?.click()}>Add more</button>}
              <button type="button" className="btn text-[13px] py-1.5" onClick={() => { setOpen(false); if (!busy) { setResult(null); setErr(''); } }} aria-label="Close">Close</button>
            </div>
          </div>
          <div className="px-4 py-3 grid gap-3 text-[13px]">
            {busy && <div className="text-accent font-medium">{busy}</div>}
            {err && <div className="text-bad"><b>{friendlyError(err, 'cv')}</b><details className="text-ink3 text-[12px] mt-1"><summary className="cursor-pointer">Technical detail</summary><pre className="whitespace-pre-wrap mt-1">{err}</pre></details></div>}

            {created.map((c: any) => {
              const cv = c.files.find((f: any) => f.kind === 'cv');
              return (
                <div key={c.id} data-drop-result="created" className="border border-line rounded p-3">
                  <div className="font-semibold text-ok">✓ New candidate {candidateLabel(c.reference_code)}</div>
                  <div className="text-ink2 mt-0.5">{c.full_name ?? 'name not printed'}{cv?.trade ? ` · ${cv.trade}` : ''} · {cv?.file}</div>
                  {cv?.namesakeNote && <div className="text-ink3 text-[12px] mt-1">{cv.namesakeNote}</div>}
                  <Link href={`/app/candidates?ref=${encodeURIComponent(c.reference_code)}`} className="text-accent text-[13px] mt-1.5 inline-block">Open {candidateLabel(c.reference_code)}</Link>
                </div>
              );
            })}

            {attachedElsewhere.map((c: any) => (
              <div key={c.id} data-drop-result="attached" className="border border-line rounded p-3">
                <div className="font-semibold">Attached to {candidateLabel(c.reference_code)}</div>
                <div className="text-ink2 mt-0.5">{c.files.map((f: any) => `${f.kind} · ${f.file}`).join(' · ')}</div>
              </div>
            ))}

            {loose.map((f: any, i: number) => {
              if (f.kind === 'other' || f.kind === 'unreadable') {
                return (
                  <div key={`l${i}`} data-drop-result="rejected" className="border border-dashed border-line rounded p-3">
                    <div className="font-semibold">Not saved — {f.kind === 'other' ? 'not a candidate document' : 'could not be read'}</div>
                    {/* A file that is simply not a candidate document says only that: friendlyError turned the reason into
                        "Something went wrong reading this CV" for a canteen menu on production (item 24 drop probe). */}
                    <div className="text-ink3 text-[12px] mt-0.5">{f.file}{f.kind === 'unreadable' && f.why ? ` · ${friendlyError(f.why, 'cv')}` : ''}</div>
                  </div>
                );
              }
              return (
                <div key={`l${i}`} data-drop-result={f.kind === 'cv' ? 'ask' : 'document'} className="border border-warn rounded p-3">
                  <div className="font-semibold">{f.kind === 'cv' ? 'Check before adding' : `Saved — ${f.kind}`}</div>
                  <div className="text-ink3 text-[12px] mt-0.5">{f.file}</div>
                  {f.needsDecision && <div className="text-warn text-[12px] mt-1">{f.needsDecision}</div>}
                  {f.documentId && !f.candidateId && <AttachChoice documentId={f.documentId} holder={f.extracted?.holder ?? f.profile?.full_name} suggest={f.suggest} compact />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
