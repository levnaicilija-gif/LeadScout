'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * What a recruiter still owes somebody, and marking one done (Today, 2026-09-17).
 *
 * Marking done NEVER deletes or hides (owner's decision): the resolution is its own record, the
 * item moves into Resolved below, and it stays on that candidate's activity history for good. It
 * only stops appearing in tomorrow's active list.
 *
 * A note is optional — ticking it off is enough on a busy morning, and demanding a sentence would
 * mean nobody ticks anything.
 */
type Item = {
  kind: 'no_reply' | 'unclear_answer';
  sourceId: string;
  candidateId: string | null;
  who: string;
  what: string;
  detail: string;
  since: string | null;
};

export function FollowupList({ active, ready }: { active: Item[]; ready: boolean }) {
  const r = useRouter();
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');

  if (!ready) {
    return <div className="text-[12.5px] text-ink3">Follow-ups can be marked done once migration 0042 is applied. They are listed here either way.</div>;
  }
  if (active.length === 0) {
    return <div data-no-followups className="text-[12.5px] text-ink3">Nothing waiting on you.</div>;
  }

  const done = async (it: Item) => {
    const key = `${it.kind}:${it.sourceId}`;
    setBusy(key); setErr('');
    try {
      const res = await fetch('/api/followup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: it.kind, source_id: it.sourceId, candidate_id: it.candidateId ?? undefined, note: note[key] || undefined }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) { setErr(j?.error ?? 'It was not marked done. Try again.'); return; }
      r.refresh();
    } catch {
      setErr('Could not reach the server — it is not marked done.');
    } finally { setBusy(''); }
  };

  return (
    <div data-followup-list>
      {active.map((it) => {
        const key = `${it.kind}:${it.sourceId}`;
        return (
          <div key={key} data-followup={key} className="border-b border-line2 py-2.5 last:border-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[12.5px]">
                <b className="font-semibold">{it.who}</b> <span className="text-ink2">— {it.what}</span>
              </span>
              <span className="flex items-center gap-2.5">
                <span className="text-[12px] text-ink2">{it.detail}</span>
                <button
                  data-mark-done={key}
                  className="btn btn-primary text-[11px]"
                  disabled={busy === key}
                  onClick={() => done(it)}
                >{busy === key ? 'Saving…' : 'Mark done'}</button>
              </span>
            </div>
            <input
              data-followup-note={key}
              className="mt-1.5 w-full rounded border border-line bg-panel px-2 py-1 text-[12px]"
              placeholder="What you did about it — optional"
              value={note[key] ?? ''}
              onChange={(e) => setNote({ ...note, [key]: e.target.value })}
            />
          </div>
        );
      })}
      {err && <div className="mt-2 text-[12.5px] text-bad">{err}</div>}
    </div>
  );
}
