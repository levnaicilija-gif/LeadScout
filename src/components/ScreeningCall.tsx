'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { takesVerdict, VERDICTS_FOR, progress, type AnswerRow, type Verdict } from '@/lib/screening';

/**
 * A screening call in progress (item 5).
 *
 * The questions are the ones that were asked, read from the call rather than regenerated: a JD can
 * be rewritten under a recruiter's feet, and the call must keep saying what was actually put to the
 * candidate.
 *
 * Each answer saves on its own as soon as the box loses focus, so a call that ends badly — the line
 * drops, the browser is closed, the laptop sleeps — loses nothing but the sentence being typed.
 *
 * A verdict control appears only where the question's kind carries one (right to work, a named
 * certificate). Everything else takes prose alone, and prose is never read for meaning: only a
 * verdict a recruiter clicked can mark the call for a re-score, and even then the stored score is
 * not rewritten — the recruiter runs it again (owner's decision, 2026-09-16).
 */
const VERDICT_LABEL: Record<string, string> = {
  yes: 'Yes', no: 'No', unclear: 'Unclear',
  confirmed: 'Confirmed', not_confirmed: 'Not confirmed',
};

const KIND_NOTE: Record<string, string> = {
  right_to_work: 'Their answer here can change whether they may start at all.',
  certificate: 'Mark this only if they were clear about it.',
};

export function ScreeningCall({ callId, candidateId, initialAnswers, finishedAt, needsRescore, rescoreReason, who }: {
  callId: string;
  candidateId: string;
  initialAnswers: AnswerRow[];
  finishedAt: string | null;
  needsRescore: boolean;
  rescoreReason: string | null;
  who: string;
}) {
  const r = useRouter();
  const [answers, setAnswers] = useState<AnswerRow[]>(initialAnswers);
  const [saving, setSaving] = useState<number | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [finished, setFinished] = useState<{ at: string | null; needs: boolean; why: string | null }>({
    at: finishedAt, needs: needsRescore, why: rescoreReason,
  });
  const [busy, setBusy] = useState(false);

  const save = async (position: number, patch: { answer?: string; verdict?: Verdict }) => {
    setSaving(position); setErr(''); setSaved(null);
    try {
      const res = await fetch('/api/screening', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'answer', call_id: callId, position, ...patch }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) { setErr(j?.error ?? 'That answer was not saved. Try again before you move on.'); return; }
      setSaved(position);
    } catch {
      setErr('Could not reach the server — that answer is not saved.');
    } finally { setSaving(null); }
  };

  const setLocal = (position: number, patch: Partial<AnswerRow>) =>
    setAnswers((rows) => rows.map((a) => (a.position === position ? { ...a, ...patch } : a)));

  const finish = async () => {
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/screening', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'finish', call_id: callId }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) { setErr(j?.error ?? 'The call could not be closed.'); return; }
      setFinished({ at: new Date().toISOString(), needs: !!j.needsRescore, why: j.rescoreReason ?? null });
      r.refresh();
    } catch {
      setErr('Could not reach the server.');
    } finally { setBusy(false); }
  };

  const { done, total } = progress(answers);

  return (
    <div data-screening-call className="max-w-[820px]">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
        <h1 className="font-display text-[24px] font-bold tracking-[-.3px] m-0">Screening call</h1>
        <span data-call-progress className="text-ink3 text-[13px]">{done} of {total} answered</span>
      </div>
      <p className="text-ink3 text-[13px] mt-0 mb-4">{who}</p>

      {finished.at && (
        <div data-call-finished className={`rounded-card border px-4 py-3 mb-4 text-[13px] ${finished.needs ? 'border-warn bg-warnsoft' : 'border-line bg-panel'}`}>
          <b className="font-semibold">Call finished</b>
          {finished.needs
            ? <div data-call-rescore className="mt-1">{finished.why}</div>
            : <div className="mt-1 text-ink3">Nothing you marked changes the score. It stands as it was.</div>}
        </div>
      )}

      <ol className="grid gap-3 list-none m-0 p-0">
        {answers.map((a) => {
          const verdicts = VERDICTS_FOR[String(a.kind)] ?? [];
          return (
            <li key={a.position} data-question={a.position} className="bg-panel border border-line rounded-card px-4 py-3.5">
              <div className="flex gap-2 items-baseline">
                <span className="text-ink3 text-[12px] tabular-nums">{a.position + 1}</span>
                <b className="font-medium text-[15px]">{a.question}</b>
              </div>
              {a.good_answer && <div className="text-ink3 text-[12px] mt-1 ml-[22px]">Good answer sounds like: {a.good_answer}</div>}

              <div className="ml-[22px] mt-2.5">
                <textarea
                  data-answer={a.position}
                  rows={2}
                  className="w-full border border-line rounded px-2 py-1.5 bg-panel text-[13.5px]"
                  placeholder="What they said"
                  defaultValue={a.answer ?? ''}
                  onChange={(e) => setLocal(a.position, { answer: e.target.value })}
                  onBlur={(e) => save(a.position, { answer: e.target.value })}
                />

                {takesVerdict(String(a.kind)) && (
                  <div className="flex gap-1.5 items-center flex-wrap mt-2">
                    {verdicts.map((v) => (
                      <button
                        key={String(v)}
                        data-verdict={`${a.position}:${v}`}
                        aria-pressed={a.verdict === v}
                        className={`btn text-[12px] ${a.verdict === v ? 'btn-primary' : ''}`}
                        onClick={() => { setLocal(a.position, { verdict: v }); save(a.position, { verdict: v }); }}
                      >{VERDICT_LABEL[String(v)]}</button>
                    ))}
                    {KIND_NOTE[String(a.kind)] && <span className="text-ink3 text-[11px]">{KIND_NOTE[String(a.kind)]}</span>}
                  </div>
                )}

                <div className="text-[11px] mt-1 h-[14px]">
                  {saving === a.position && <span className="text-ink3">saving…</span>}
                  {saved === a.position && saving !== a.position && <span className="text-ok">saved</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {err && <div className="text-bad text-[13px] mt-3">{err}</div>}

      <div className="flex gap-2 mt-4 flex-wrap items-center">
        <button className="btn btn-primary" data-finish-call disabled={busy} onClick={finish}>
          {busy ? 'Closing…' : finished.at ? 'Update the call' : 'Finish the call'}
        </button>
        <a className="btn" href={`/app/candidates/${candidateId}`}>Back to the candidate</a>
        <span className="text-ink3 text-[12px]">Answers save as you go; finishing only works out whether the score should be run again.</span>
      </div>
    </div>
  );
}
