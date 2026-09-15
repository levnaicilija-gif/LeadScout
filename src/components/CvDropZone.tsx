'use client';
import { usePathname } from 'next/navigation';
import { useRef, useState } from 'react';
import { cvDrop, useCvDrop } from '@/lib/cv-drop-store';
import { DROP_OVER, DROP_OVER_RAIL } from '@/lib/tool-colour';

/**
 * "Drop a CV here — or click to browse": one control for adding a candidate, shown where a recruiter can see it (item 24
 * follow-up, owner's review of production 2026-09-15 — dropping a CV anywhere worked, and nothing on screen said so).
 *
 * Dropping a file on it and clicking it are the same action: CandidateDrop reads the file through Verify's intake and shows
 * the result. It highlights while a file is held over it, and more faintly while a file is dragged anywhere on the page.
 *
 *   variant "rail"  the foot of the rail on every rail screen
 *   variant "home"  a card on Home, which has no rail (owner's decision)
 *
 * Desktop only (lg and up): below that the rail lies down as a bar and a touch screen cannot drag files, so CandidateDrop's
 * floating "+ Add CV" button is the way in. Verify stands aside — its own drop zone is the way in there (owner's decision).
 */
export function CvDropZone({ variant }: { variant: 'rail' | 'home' }) {
  const pathname = usePathname() ?? '';
  const { busy, dragging } = useCvDrop();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  if (pathname.startsWith('/app/verify')) return null;

  const withFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const rail = variant === 'rail';
  const tone = over ? (rail ? `${DROP_OVER_RAIL.cand} text-white` : DROP_OVER.cand)
    : dragging ? (rail ? 'border-railink bg-white/[.06]' : 'border-ink3 bg-panel')
      : rail ? 'border-white/25 hover:border-white/50 hover:bg-white/[.04]' : 'border-line bg-panel hover:border-ink3';

  return (
    <button
      type="button"
      data-cv-drop-zone={variant}
      data-cv-drop-over={over ? 'true' : 'false'}
      aria-busy={busy}
      aria-label="Drop a CV here — or click to browse"
      onClick={() => cvDrop.browse()}
      onDragEnter={(e) => { if (!withFiles(e)) return; e.preventDefault(); depth.current++; setOver(true); }}
      onDragOver={(e) => { if (!withFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDragLeave={(e) => { if (!withFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setOver(false); }}
      // preventDefault marks the drop as handled, so CandidateDrop's page-wide listener does not read the same file twice.
      onDrop={(e) => { if (!withFiles(e)) return; e.preventDefault(); depth.current = 0; setOver(false); cvDrop.run(Array.from(e.dataTransfer.files)); }}
      className={rail
        ? `w-full flex flex-col items-center gap-0.5 text-center rounded-card border-2 border-dashed px-3 py-4 text-[12.5px] transition-colors cursor-pointer ${tone}`
        // Above CandidateDrop's page-wide overlay (z-50), so Home's zone still shows its highlight while a file is dragged.
        : `relative z-[51] hidden lg:flex w-full flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center rounded-card border-2 border-dashed px-5 py-5 mb-6 text-[14px] transition-colors cursor-pointer ${tone}`}
    >
      <b className={`font-semibold pointer-events-none ${rail ? 'text-white text-[13px]' : 'text-ink'}`}>{busy ? 'Reading the CV…' : over ? 'Release to add the CV' : 'Drop a CV here'}</b>
      <span className={`pointer-events-none ${rail ? 'text-raildim' : 'text-ink3'}`}>{busy ? 'the result opens beside you' : '— or click to browse'}</span>
    </button>
  );
}
