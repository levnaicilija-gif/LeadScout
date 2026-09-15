'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AttachChoice } from './AttachChoice';
import { candidateLabel } from '@/lib/candidate-number';
import { friendlyError } from '@/lib/friendly-error';
import { cvDrop } from '@/lib/cv-drop-store';

/**
 * Add a candidate from any screen (item 24): drag CV files anywhere onto the app, drop them on the "Drop a CV here" zone,
 * click that zone, or press "+ Add CV".
 *
 * It is Verify's intake, unchanged in what it reads — the same document recognition and CV parsing — and the same
 * duplicate rule: a name plus a second field. A new person becomes a record; someone who looks like a person already in
 * the pool is stored and asked about, never merged; anything that is not a candidate document is not saved. The
 * anonymised client version is not made here — that is an action on the candidate's page.
 *
 * The ways in (item 24 follow-up, 2026-09-15 — dropping anywhere worked and nothing on screen said so): at lg and up,
 * CvDropZone at the foot of the rail and on Home; below lg, where the rail lies down as a bar and a touch screen cannot
 * drag files, the floating "+ Add CV" button — never both at one width. They all call this component through
 * `cv-drop-store`. Verify keeps its own drop zone (which also runs the client version and questions), so everything here
 * stands aside there, and on onboarding.
 */
const TIMEOUT_MS = 150_000;
// How long after the last dragover a drag counts as over. A browser fires dragover every 350 ms or more often while a file is
// held still over the page (HTML drag-and-drop processing model), so a pause this long means the file has gone.
const IDLE_MS = 1000;

export function CandidateDrop() {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const standAside = pathname.startsWith('/app/verify') || pathname.startsWith('/app/onboarding');
  const [dragging, setDragging] = useState(false);
  const [overlayLeft, setOverlayLeft] = useState(0);
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
    cvDrop.set({ busy: true });
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
      // The screen behind the panel re-reads, so a new candidate is in the list and a new CV in its count without a reload.
      router.refresh();
    } catch (e: any) {
      setErr(e?.name === 'AbortError' ? `took longer than ${TIMEOUT_MS / 1000}s and was stopped` : String(e?.message ?? e));
    } finally {
      clearTimeout(timer);
      busyRef.current = false;
      cvDrop.set({ busy: false });
      setBusy('');
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  // The zones on the rail and on Home reach the reading through here. Clicking one while a file is being read opens the panel.
  useEffect(() => cvDrop.register({
    run: (files) => runRef.current(files),
    browse: () => { if (busyRef.current) setOpen(true); else input.current?.click(); },
  }), []);

  useEffect(() => {
    if (standAside) return;
    const withFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    // Where the rail's zone is on screen, the overlay starts beside the rail, so the zone's highlight stays in view.
    const railRight = () => {
      const zone = document.querySelector<HTMLElement>('[data-cv-drop-zone="rail"]');
      return zone && zone.offsetParent ? Math.round(zone.closest('nav')?.getBoundingClientRect().right ?? 0) : 0;
    };
    // The overlay is up only while a file is really being dragged over the page. Counting dragenter against dragleave is
    // not enough on its own: a browser does not always send the dragleave that balances an enter — an element re-rendered
    // or removed under the cursor never gets one, and a drag cancelled with Escape or let go outside the window may send
    // none — and a count left above zero kept "Drop CVs to add candidates" on screen with nothing being dragged (owner's
    // report, 2026-09-15). So the drag also ends when dragover stops arriving: while a file is held over the page the
    // browser fires it continually, and IDLE_MS after the last one the file is no longer there.
    let idle: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { clearTimeout(idle); depth.current = 0; setDragging(false); cvDrop.set({ dragging: false }); };
    const alive = () => { clearTimeout(idle); idle = setTimeout(stop, IDLE_MS); };
    const enter = (e: DragEvent) => {
      if (!withFiles(e)) return;
      e.preventDefault();
      if (depth.current++ === 0) setOverlayLeft(railRight());
      setDragging(true); cvDrop.set({ dragging: true });
      alive();
    };
    // Captured, so a zone that stops the event (a certificate zone on a candidate's page) still keeps the drag alive.
    const over = (e: DragEvent) => { if (!withFiles(e)) return; alive(); };
    const allowDrop = (e: DragEvent) => { if (!withFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const leave = (e: DragEvent) => { if (!withFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) stop(); };
    // Captured, so every drop ends the drag — including one a zone handles and stops, like a certificate on a candidate's page.
    const ended = (e: DragEvent) => { if (withFiles(e)) stop(); };
    const drop = (e: DragEvent) => {
      // A drop the CV zone already took is marked handled; reading it here too would read the file twice.
      if (!withFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      runRef.current(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over, true);
    window.addEventListener('dragover', allowDrop);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', ended, true);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('dragover', allowDrop);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', ended, true);
      window.removeEventListener('drop', drop);
      stop();
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

      {/* Narrow widths only: at lg and up the zone on the rail or on Home is the way in, and a second control would repeat it. */}
      <button type="button" data-candidate-drop-button onClick={() => (result || err || busy ? setOpen(!open) : input.current?.click())}
        className="lg:hidden fixed z-40 right-4 bottom-4 btn btn-primary shadow-lg flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
        {busy ? 'Reading…' : result || err ? (open ? 'Hide' : 'Added') : 'Add CV'}
      </button>

      {dragging && (
        <div data-candidate-drop-overlay style={{ left: overlayLeft }} className="fixed top-0 right-0 bottom-0 z-50 bg-rail/70 grid place-items-center px-4 pointer-events-none">
          <div className="w-full max-w-[520px] border-2 border-dashed border-white rounded-tile px-6 py-12 text-center text-white">
            <b className="block font-display text-[22px] font-bold">Drop CVs to add candidates</b>
            <div className="text-[13px] mt-1.5 text-railink">Read the same way Verify reads them · someone already in the pool is asked about, never merged</div>
          </div>
        </div>
      )}

      {open && (busy || err || result) && (
        <div data-candidate-drop-panel data-candidate-drop-busy={busy ? 'true' : 'false'}
          className="fixed z-40 right-4 bottom-[72px] lg:bottom-4 w-[min(440px,calc(100vw-32px))] max-h-[70vh] overflow-auto bg-panel border border-line rounded-card shadow-xl">
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
                  {f.documentId && !f.candidateId && <AttachChoice documentId={f.documentId} holder={f.extracted?.holder ?? f.profile?.full_name} suggest={f.suggest} compact onDone={() => router.refresh()} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
