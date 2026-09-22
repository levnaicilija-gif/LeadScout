'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * "Jobs this person fits" — shown on Verify as soon as a CV has been read, without being asked.
 *
 * NOTHING HERE ACTS. It ranks and it explains; attaching, sending and confirming stay where they
 * already are, behind a recruiter's own click. The number beside each row is the model's, the
 * blocker beneath it is not — a right-to-work verdict is decided in code by checkRightToWork, and a
 * blocked job sinks below every workable one however well it scored.
 *
 * It says what it looked at and what it did not, because the honest scope is narrower than the
 * feature sounds: won-work leads need a job description to be scored against and only 2 of 189 have
 * one, so this reads open Hiring now postings. A list that quietly covered half the board would be
 * worse than one that says which half it read.
 */

type Match = {
  jobId: string; score: number; fits: string[]; missing: string[]; blockers: string[];
  from: 'description' | 'fetched' | 'title'; chars: number;
  role: string | null; company: string | null; url: string | null; why: string | null;
};
type Result = {
  scope: string; considered: number; shortlisted: number; matches: Match[];
  skipped: { jobId: string; why: string }[]; why?: string; ms: number;
};

const band = (n: number) => (n >= 70 ? 'text-ok' : n >= 45 ? 'text-warn' : 'text-ink3');

export function JobSuggestions({ candidateId, reference }: { candidateId: string; reference?: string }) {
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(true);
  // React runs effects twice in development; without this the drop would be scored twice and paid
  // for twice. Guarding on the id rather than a bare boolean, so a different candidate still runs.
  const ranFor = useRef<string | null>(null);

  useEffect(() => {
    if (ranFor.current === candidateId) return;
    ranFor.current = candidateId;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 110_000);
    (async () => {
      try {
        const r = await fetch('/api/candidate/suggest', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ candidate_id: candidateId }), signal: ac.signal,
        });
        const body = await r.text();
        let json: any = null;
        try { json = body ? JSON.parse(body) : null; } catch { /* an error page, not JSON */ }
        if (!r.ok) throw new Error(json?.error ?? `the job match failed (HTTP ${r.status})`);
        if (!json) throw new Error('the job match returned something that is not JSON');
        setRes(json);
      } catch (e: any) {
        setErr(e?.name === 'AbortError' ? 'took longer than 110s and was stopped' : (e?.message ?? String(e)));
      } finally { clearTimeout(timer); setBusy(false); }
    })();
    return () => { clearTimeout(timer); ac.abort(); };
  }, [candidateId]);

  const shown = res?.matches ?? [];

  return (
    <div data-job-suggestions={busy ? 'working' : err ? 'failed' : 'done'} className="mt-3 pt-3 border-t border-line2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <b className="text-[13px] font-semibold">Jobs this person fits</b>
        {busy && <span className="text-[12px] text-accent">looking at the open postings…</span>}
        {!busy && res && (
          <span className="text-[12px] text-ink3">
            {res.shortlisted} of {res.considered} {res.scope} worth checking · {(res.ms / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {/* The scope is stated, never implied: this does not read won-work leads yet. */}
      {!busy && res && (
        <div className="text-[11.5px] text-ink3 mt-0.5">
          Read from {res.scope}. Won work leads are not matched here yet — they need a job description first.
        </div>
      )}

      {err && (
        <div className="mt-2 text-[12px]">
          <b className="text-bad">The job match could not be run.</b>
          <span className="text-ink3"> Everything else on this CV is unaffected.</span>
          <details className="mt-1 text-ink3"><summary className="cursor-pointer">Technical detail</summary><pre className="whitespace-pre-wrap mt-1">{err}</pre></details>
        </div>
      )}

      {!busy && !err && !shown.length && (
        <div className="text-[12.5px] text-ink3 mt-2" data-suggestion-empty>
          {res?.why ?? 'No open posting is a plausible fit for this person.'} Nothing is suggested rather than something weak.
        </div>
      )}

      {shown.map((m, i) => (
        <div key={m.jobId} data-suggestion={i} className={`mt-2 rounded-[10px] border px-3 py-2.5 ${m.blockers.length ? 'border-dashed border-warn bg-transparent' : 'border-line bg-panel'}`}>
          <div className="flex items-baseline gap-2 flex-wrap">
            <b className={`text-[14px] font-semibold tabular-nums ${band(m.score)}`} data-suggestion-score>{m.score}</b>
            <span className="text-[13px] font-medium min-w-0 break-words">{m.role ?? 'role not stated'}</span>
            {m.company && <span className="text-[12px] text-ink3">· {m.company}</span>}
          </div>

          {/* How much there was to judge. A suggestion built on a 37-character title says so. */}
          {m.from === 'title' && (
            <div className="text-[11.5px] text-warn mt-1">
              Judged on the advert&apos;s title alone ({m.chars} characters) — the advert itself could not be read.
            </div>
          )}

          {m.blockers.length > 0 && (
            <div className="text-[12px] text-warn mt-1"><b>Cannot be put forward:</b> {m.blockers[0]}</div>
          )}
          {m.fits.length > 0 && <div className="text-[12px] text-ink3 mt-1"><span className="text-ok">Fits</span> — {m.fits.slice(0, 3).join(' · ')}</div>}
          {m.missing.length > 0 && <div className="text-[12px] text-ink3 mt-0.5"><span className="text-warn">Missing</span> — {m.missing.slice(0, 3).join(' · ')}</div>}

          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[11.5px]">
            <a className="text-accent underline" href={`/app/radar?tab=hiring`}>Open in Hiring now</a>
            {m.url && <a className="text-accent underline break-all" href={m.url} target="_blank" rel="noreferrer">The advert</a>}
          </div>
        </div>
      ))}

      {!busy && !err && shown.length > 0 && (
        <div className="text-[11.5px] text-ink3 mt-2">
          Suggestions only — nothing has been attached or sent{reference ? ` for ${reference}` : ''}.
        </div>
      )}
    </div>
  );
}
