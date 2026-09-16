'use client';
import { useEffect, useState } from 'react';

/**
 * What a senior expects a day to hold. Six numbers, or none.
 *
 * A blank field is not a target of zero — it means that line is not measured, and the scorecard
 * then shows the count alone rather than "0 of 0", which reads as failing a target nobody set.
 * That distinction is the whole reason these are nullable.
 *
 * Nothing here judges anybody: the targets only ever produce "3 of 5" on the scorecard, never an
 * adjective (owner's decision, 2026-09-16).
 */
const FIELDS: [string, string][] = [
  ['packs_prepared', 'Packs prepared'],
  ['cvs_sent', 'CVs sent'],
  ['outreach_sent', 'Outreach sent'],
  ['verifications', 'Verifications'],
  ['leads_confirmed', 'Leads confirmed'],
  ['candidates_added', 'Candidates added'],
];

export function DailyTargets() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/scorecard')
      .then((r) => r.json())
      .then((j) => {
        setReady(!!j.ready);
        if (j.ready) {
          const next: Record<string, string> = {};
          for (const l of j.lines ?? []) next[l.key] = l.target === null ? '' : String(l.target);
          setVals(next);
        }
      })
      .catch(() => setReady(false));
  }, []);

  if (ready === null) return <div className="text-ink3 text-[13px]">Reading the targets…</div>;
  if (!ready) return <div className="text-ink3 text-[13px]">The scorecard tables are not in the database yet (migration 0039). Nothing is measured until they are.</div>;

  const save = async () => {
    setBusy(true); setErr(''); setSaved(false);
    try {
      const res = await fetch('/api/scorecard', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'targets', targets: vals }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) { setErr(j?.error ?? 'The targets could not be saved.'); return; }
      setSaved(true);
    } catch {
      setErr('Could not reach the server.');
    } finally { setBusy(false); }
  };

  return (
    <div data-daily-targets className="bg-panel border border-line rounded-card p-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {FIELDS.map(([key, label]) => (
          <label key={key} className="grid gap-1">
            <span className="text-[12px] text-ink3">{label}</span>
            <input
              type="number" min={0} max={999} inputMode="numeric"
              data-target={key}
              className="border border-line rounded px-2 py-1.5 bg-panel"
              placeholder="not measured"
              value={vals[key] ?? ''}
              onChange={(e) => { setVals({ ...vals, [key]: e.target.value }); setSaved(false); }}
            />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save targets'}</button>
        {saved && <span className="text-ok text-[13px]">Saved.</span>}
        {err && <span className="text-bad text-[13px]">{err}</span>}
      </div>
      <p className="text-ink3 text-[12px] mt-2 max-w-[70ch]">Leave a field empty to leave that line unmeasured — the scorecard then shows the count on its own. These set the workspace&apos;s default for everyone.</p>
    </div>
  );
}
