'use client';
import { useEffect, useState } from 'react';

/**
 * A person's day, counted from the data, with room for the three lines only they can write.
 *
 * The counts are facts and are shown as facts: "3 of 5" where a senior set a target, "3" where
 * nobody did. There is no adjective here and no warmth that varies with the numbers — a tone keyed
 * to the count teaches people to read the tone instead of the number, and on a day with no targets
 * set there is nothing to be pleased or disappointed about (owner's decision, 2026-09-16).
 *
 * What a recruiter writes is their own; a senior's reply is a person's words, not generated.
 */
type Line = { key: string; label: string; n: number; target: number | null; from: string; caveat?: string };

export function Scorecard({ day, userId, compact }: { day?: string; userId?: string; compact?: boolean }) {
  const [state, setState] = useState<any>(null);
  const [notes, setNotes] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    const q = new URLSearchParams();
    if (day) q.set('day', day);
    if (userId) q.set('user', userId);
    const j = await fetch(`/api/scorecard?${q}`).then((r) => r.json()).catch(() => null);
    if (!j) { setErr('The scorecard could not be read.'); return; }
    setState(j);
    setNotes(j.notes ?? '');
    setReply(j.reply ?? '');
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [day, userId]);

  if (err) return <div data-scorecard className="text-bad text-[13px]">{err}</div>;
  if (!state) return null;
  if (!state.ready) return null; // 0039 not applied: the screen simply does not carry this yet.

  const lines: Line[] = state.lines ?? [];
  const save = async (action: 'notes' | 'reply') => {
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/scorecard', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'notes'
          ? { action, day: state.day, notes }
          : { action, day: state.day, user_id: state.userId, reply }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) { setErr(j?.error ?? 'It could not be saved.'); return; }
      await load();
    } catch {
      setErr('Could not reach the server.');
    } finally { setBusy(false); }
  };

  return (
    <div data-scorecard className="bg-panel border border-line rounded-card p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <b className="text-[15px] font-semibold">{compact ? 'Yesterday' : 'Your day'}</b>
        <span className="text-ink3 text-[12px]">{state.day}</span>
      </div>

      <ul data-scorecard-lines className="grid gap-1 mt-2 text-[13px]">
        {lines.map((l) => (
          <li key={l.key} className="grid grid-cols-[1fr_auto] gap-2 items-baseline">
            <span>
              {l.label}
              {l.caveat && <span className="text-ink3 text-[11px]"> · {l.caveat}</span>}
            </span>
            <b data-line={l.key} className="font-semibold tabular-nums">
              {l.target === null ? l.n : `${l.n} of ${l.target}`}
            </b>
          </li>
        ))}
      </ul>

      {!state.targetsSet && (
        <div data-no-targets className="text-ink3 text-[12px] mt-2">No targets set, so these counts are not measured against anything.</div>
      )}
      {(state.unavailable ?? []).length > 0 && (
        <div className="text-warn text-[12px] mt-1">Not countable per day yet: {(state.unavailable ?? []).join(', ')} — migration 0039.</div>
      )}

      {!compact && (
        <div className="mt-3">
          <label className="text-[12px] text-ink3 block mb-1">Your three lines — what happened today, in your words</label>
          <textarea
            data-scorecard-notes rows={3}
            className="w-full border border-line rounded px-2 py-1.5 bg-panel text-[13px]"
            value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="What moved, what stuck, what you need."
          />
          <button className="btn btn-primary mt-2" disabled={busy} onClick={() => save('notes')}>
            {busy ? 'Saving…' : state.submittedAt ? 'Update' : 'Save'}
          </button>
          {state.submittedAt && <span className="text-ink3 text-[12px] ml-2">Saved {new Date(state.submittedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>}
        </div>
      )}

      {state.reply && (
        <div data-scorecard-reply className="mt-3 border-t border-line2 pt-2 text-[13px]">
          <span className="text-ink3 text-[12px]">A senior replied</span>
          <div className="whitespace-pre-wrap">{state.reply}</div>
        </div>
      )}

      {state.canReply && (
        <div className="mt-3 border-t border-line2 pt-2">
          <label className="text-[12px] text-ink3 block mb-1">Your reply — in your own words</label>
          <textarea
            data-scorecard-reply-box rows={2}
            className="w-full border border-line rounded px-2 py-1.5 bg-panel text-[13px]"
            value={reply} onChange={(e) => setReply(e.target.value)}
          />
          <button className="btn mt-2" disabled={busy} onClick={() => save('reply')}>{busy ? 'Saving…' : 'Reply'}</button>
        </div>
      )}

      {err && <div className="text-bad text-[13px] mt-2">{err}</div>}
    </div>
  );
}
