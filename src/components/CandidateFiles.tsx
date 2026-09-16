import Link from 'next/link';
import { candidateLabel } from '@/lib/candidate-number';

/**
 * Every file on a candidate, in one list (item 24 follow-up 3, step 5 — before it, files showed only as counts, "3 CV files
 * on file"). All their CVs, the newest marked current and the rest kept as history (owner's decision, 2026-09-15), and every
 * certificate and other document: the name, the type, when it was added and by whom.
 *
 * The name shown is the one a download gets — "candidate-9-cv.pdf". The name the file arrived with is not stored: it usually
 * carries the person's name, which is why storage paths hold a digest instead (CLAUDE.md, storage paths).
 */
export type CandidateFile = {
  id: string; type: string; certBody: string | null; level: string | null;
  uploadedAt: string; by: string; ext: string; current: boolean;
};

const typeLabel = (f: CandidateFile) =>
  f.type === 'cv' ? 'CV'
    : f.type === 'certificate' ? [f.certBody?.toUpperCase(), f.level].filter(Boolean).join(' ') || 'certificate'
      : f.type.replace(/_/g, ' ');

export function CandidateFiles({ candidateId, reference, files }: { candidateId: string; reference: string | null; files: CandidateFile[] }) {
  if (files.length === 0) return <div className="text-ink3 text-[13px]">No files on file. Drop a CV or a certificate to add one.</div>;
  const number = candidateLabel(reference).replace(/^#/, '') || 'unassigned';
  return (
    <ul data-candidate-files className="list-none m-0 p-0 grid gap-1.5 text-[13px]">
      {files.map((f) => (
        <li key={f.id} data-candidate-file={f.type} data-file-id={f.id} data-file-current={f.current ? 'true' : 'false'} className="border border-line2 rounded px-3 py-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="min-w-0">
            <b className="font-semibold break-all">candidate-{number}-{f.type}.{f.ext}</b>
            <span className="badge ml-2">{typeLabel(f)}</span>
            {f.type === 'cv' && <span className={`badge ml-1.5 ${f.current ? 'badge-ok' : ''}`}>{f.current ? 'current' : 'earlier version'}</span>}
            <div className="text-ink3 text-[12px]">added {new Date(f.uploadedAt).toLocaleDateString('en-GB')} by {f.by}</div>
          </div>
          <div className="flex gap-3 text-[12.5px] shrink-0">
            {f.type === 'cv' && f.current && <Link href={`/app/candidates/${candidateId}/cv`} className="text-accent">Read CV</Link>}
            {f.type !== 'cv' && <Link href={`/app/candidates/${candidateId}/documents/${f.id}`} className="text-accent">View original</Link>}
            <a href={`/api/candidates/document?id=${f.id}&download=1`} className="text-accent" data-file-download>Download</a>
          </div>
        </li>
      ))}
    </ul>
  );
}
