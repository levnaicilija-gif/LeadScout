'use client';
import { useEffect, useState } from 'react';
import { Scorecard } from './Scorecard';

/**
 * The team's days, for a senior to read and answer.
 *
 * This is deliberately a small list on Settings rather than a general "needs your review" queue:
 * no such queue exists yet — `needsReview` in onboarding.ts is only a sentence on Today telling a
 * junior their sends go to a senior — and building one as a side effect of the scorecard would
 * decide the shape of something that belongs to item 9. Recorded here so it is not mistaken for
 * that queue having been built (2026-09-16).
 *
 * Only days somebody actually wrote on are listed. A day with counts but no words is not waiting
 * for anyone, and a list of every person × every day would bury the ones that are.
 */
type Row = { user_id: string; name: string | null; day: string; notes: string; submitted_at: string | null; reply: string | null };

export function TeamScorecards() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<{ day: string; userId: string } | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    fetch('/api/scorecard/team')
      .then((r) => r.json())
      .then((j) => { if (j.ready === false) { setRows([]); return; } setRows(j.rows ?? []); })
      .catch(() => setErr('The team\'s scorecards could not be read.'));
  }, []);

  if (err) return <div className="text-bad text-[13px]">{err}</div>;
  if (!rows) return <div className="text-ink3 text-[13px]">Reading…</div>;
  if (rows.length === 0) return <div className="text-ink3 text-[13px]">Nobody has written up a day yet.</div>;

  return (
    <div data-team-scorecards className="bg-panel border border-line rounded-card">
      <ul>
        {rows.map((r) => (
          <li key={`${r.user_id}-${r.day}`} className="border-b border-line2 last:border-0">
            <button
              className="w-full text-left px-4 py-3 grid grid-cols-[1fr_auto] gap-2 items-baseline"
              onClick={() => setOpen(open?.day === r.day && open?.userId === r.user_id ? null : { day: r.day, userId: r.user_id })}
            >
              <span>
                <b className="font-medium">{r.name ?? 'Someone'}</b>
                <span className="text-ink3 text-[12px]"> · {r.day}</span>
                <span className="block text-ink3 text-[12px] truncate">{r.notes.replace(/\s+/g, ' ').slice(0, 90)}</span>
              </span>
              <span className={`text-[12px] ${r.reply ? 'text-ok' : 'text-ink3'}`}>{r.reply ? 'replied' : 'no reply yet'}</span>
            </button>
            {open?.day === r.day && open?.userId === r.user_id && (
              <div className="px-4 pb-4">
                <Scorecard day={r.day} userId={r.user_id} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
