'use client';
import { useState } from 'react';
import { WhyThisScore } from './WhyThisScore';

/**
 * One scored candidate on the lead's score card, with the call attached.
 *
 * The score already knows what is missing and what blocks this person for this job. Making the
 * recruiter go to Verify, find the candidate and re-select the job to get the questions threw
 * that away and asked for it again. The questions come from the score that is already on screen.
 */
export function ScoredCandidate({ x, jd, jobCountry, company, leadId, jdVersion }: {
  x: any;
  jd?: string | null;
  jobCountry?: string | null;
  /** The company being scored against, so the call can ask about a shared employer. */
  company?: { name?: string | null; domain?: string | null } | null;
  /** Item 5: which job, and at which JD version, a screening call is about. */
  leadId?: string | null;
  jdVersion?: number | null;
}) {
  const [busy, setBusy] = useState(false);
  const [questions, setQuestions] = useState<any[] | null>(null);
  const [basedOn, setBasedOn] = useState('');
  const [err, setErr] = useState('');
  const [starting, setStarting] = useState(false);

  /**
   * Take these questions onto a call. They are copied into the call as asked — a later JD rewrite
   * regenerates the questions, and yesterday's answers must keep pointing at what was really put to
   * the candidate (item 5, migration 0040).
   */
  const startCall = async () => {
    setStarting(true); setErr('');
    try {
      const res = await fetch('/api/screening', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'start', candidate_id: x.id, lead_id: leadId ?? undefined,
          jd_version: typeof jdVersion === 'number' ? jdVersion : undefined,
          questions,
        }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.call?.id) { setErr(j?.error ?? 'The call could not be started.'); return; }
      window.location.href = `/app/candidates/${x.id}/call/${j.call.id}`;
    } catch {
      setErr('Could not reach the server.');
    } finally { setStarting(false); }
  };

  const ask = async () => {
    setBusy(true); setErr('');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const res = await fetch('/api/candidate/questions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal,
        body: JSON.stringify({
          candidate_id: x.id, job: jd || undefined, job_country: jobCountry || undefined,
          company_name: company?.name || undefined, company_domain: company?.domain || undefined,
        }),
      });
      const body = await res.text();
      let j: any = null;
      try { j = body ? JSON.parse(body) : null; } catch { /* an error page, not JSON */ }
      if (!res.ok || !j) { setErr(j?.error ?? 'The questions could not be written. Try again.'); return; }
      setQuestions(j.questions ?? []);
      setBasedOn(j.basedOn ?? '');
    } catch (e: any) {
      setErr(e?.name === 'AbortError' ? 'This took longer than 60 seconds and was stopped. Try again.' : 'Could not reach the server.');
    } finally { clearTimeout(timer); setBusy(false); }
  };

  return (
    <div data-scored-candidate={x.reference_code} className="px-3 py-2 border-b border-line2 last:border-0">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <span>
          <b className="font-medium">{x.reference_code}</b>
          {/* Item 11: employer names only. It never claims the site — the CV stores no site. */}
          {x.previousEmployer ? (
            <span
              data-previous-employer={x.previousEmployer.tone}
              title={x.previousEmployer.headline.why}
              className={`badge ml-1.5 align-middle ${x.previousEmployer.tone === 'warn' ? 'badge-warn' : 'badge-ok'}`}
            >{x.previousEmployer.label}</span>
          ) : null}
          <div className="text-[12px] text-ink3">
            {x.fits.slice(0, 2).join(' · ')}
            {x.missing.length ? ` · missing: ${x.missing[0]}` : ''}
            {x.blockers.length ? <span className="text-bad"> · blocker: {x.blockers[0]}</span> : ''}
            {x.rightToWork?.rule ? <div className="text-ink3 text-[11px] mt-0.5">{x.rightToWork.rule}</div> : null}
          </div>
        </span>
        <b className="text-accent">{x.score}</b>
      </div>

      <WhyThisScore x={x} />

      <div className="mt-1.5">
        <button className="btn text-[12px]" disabled={busy} onClick={ask}>
          {busy ? 'Writing…' : questions ? 'Rewrite questions' : 'Questions for this candidate'}
        </button>
        {questions?.length ? (
          <button className="btn text-[12px] ml-1.5" onClick={() => navigator.clipboard.writeText(questions.map((q, i) => `${i + 1}. ${q.q}\n   Good: ${q.good_answer}`).join('\n\n'))}>Copy</button>
        ) : null}
        {/* Item 5: the questions go with the recruiter onto the call, and what is said is kept. */}
        {questions?.length ? (
          <button className="btn btn-primary text-[12px] ml-1.5" data-start-call disabled={starting} onClick={startCall}>
            {starting ? 'Starting…' : 'Start screening call'}
          </button>
        ) : null}
      </div>

      {err && <div className="text-bad text-[12px] mt-1">{err}</div>}

      {questions && (
        questions.length === 0
          ? <div className="text-ink3 text-[12px] mt-1">No questions came back. Try again.</div>
          : (<>
            {basedOn && <div className="text-ink3 text-[11px] mt-1">From {basedOn}</div>}
            <ol className="list-decimal pl-[18px] mt-1 text-[13px]">
              {questions.map((q, i) => (
                <li key={i} className="mb-1.5">
                  <b className="font-medium block">{q.q}</b>
                  {q.good_answer && <small className="text-ink3">Good answer sounds like: {q.good_answer}</small>}
                </li>
              ))}
            </ol>
          </>)
      )}
    </div>
  );
}
