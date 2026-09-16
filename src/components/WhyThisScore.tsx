'use client';

/**
 * Item 11 part 2: why this score, requirement by requirement.
 *
 * Shut by default, because a recruiter scanning a ranked pool wants the number; open when they
 * are about to ring somebody and need to know what to push on.
 *
 * Every line comes from the scoring call itself, which read both the job and the CV — not from a
 * second model explaining the first one's number. `evidence` is quoted from the candidate data and
 * has already been traced against it (scoreAgainstJob); anything untraceable was dropped before it
 * reached here and is reported as a count, the way an unsupported bullet is.
 *
 * Where the call returned no requirement lines at all, this falls back to the three lists the score
 * has always carried — and says that is what it is doing, rather than showing an empty box.
 */
export function WhyThisScore({ x }: { x: any }) {
  const reasons: { requirement: string; met: boolean; evidence: string }[] = x?.reasons ?? [];
  const dropped: number = x?.droppedReasons ?? 0;
  const fits: string[] = x?.fits ?? [];
  const missing: string[] = x?.missing ?? [];
  const blockers: string[] = x?.blockers ?? [];
  if (!reasons.length && !fits.length && !missing.length && !blockers.length) return null;

  return (
    <details data-why-score className="mt-1.5">
      <summary className="cursor-pointer text-ink3 text-[12px]">Why this score</summary>

      {reasons.length > 0 ? (
        <ul data-why-score-reasons className="mt-1.5 grid gap-1 text-[12px] leading-relaxed">
          {reasons.map((r, i) => (
            <li key={i} className="grid grid-cols-[auto_1fr] gap-1.5">
              <span className={r.met ? 'text-ok' : 'text-warn'} aria-hidden>{r.met ? '✓' : '·'}</span>
              <span>
                <b className="font-medium">{r.requirement}</b>
                {r.evidence
                  ? <span className="text-ink3"> — {r.evidence}</span>
                  : <span className="text-ink3"> — nothing in the CV speaks to this</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div data-why-score-fallback className="mt-1.5 text-[12px] leading-relaxed">
          <div className="text-ink3">The score did not come back with the job's requirements line by line, so this is what it did say:</div>
          {fits.length > 0 && <div className="mt-1"><span className="text-ok">Fits</span> {fits.join(' · ')}</div>}
          {missing.length > 0 && <div><span className="text-warn">Missing</span> {missing.join(' · ')}</div>}
          {blockers.length > 0 && <div><span className="text-bad">Blocker</span> {blockers.join(' · ')}</div>}
        </div>
      )}

      {x?.rightToWork?.rule && <div className="mt-1 text-ink3 text-[11px]">{x.rightToWork.rule}</div>}
      {dropped > 0 && (
        <div data-why-score-dropped className="mt-1 text-warn text-[11px]">
          Dropped {dropped} line{dropped === 1 ? '' : 's'} that could not be traced to the CV.
        </div>
      )}
    </details>
  );
}
