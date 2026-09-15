'use client';
import { useState } from 'react';
import { STAGES, STAGE_LABEL, type Stage } from '@/lib/candidate-stages';

/**
 * Moving a candidate between stages, the same way from a table row, a kanban card or the candidate's page (item 24).
 *
 * Placed is a record: choosing it opens a prompt for the client and the start date, and nothing moves until both are
 * given. Leaving Placed asks for the day the placement ended. The server (api/candidates/stage) holds the same rules, so
 * a drag cannot skip them either.
 */
export type MoveResult = { ok: boolean; stage?: Stage; error?: string };
type Pending = { to: Stage; kind: 'placement' | 'end'; placedAt?: string };

const today = () => new Date().toISOString().slice(0, 10);

export async function postStage(candidateId: string, stage: Stage, extra: Record<string, unknown> = {}): Promise<MoveResult & { needsEndDate?: boolean; open?: { client_name: string }[] }> {
  try {
    const r = await fetch('/api/candidates/stage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidate_id: candidateId, stage, ...extra }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.error ?? `the stage could not be saved (HTTP ${r.status})`, needsEndDate: j.needsEndDate, open: j.open };
    return { ok: true, stage: j.stage };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * The move itself, with its prompts. `request(to)` starts a move; the dialog renders when a prompt is needed.
 * onMoved runs after the server accepted the move.
 */
export function useStageMove(candidate: { id: string; name: string | null; stage: Stage; placedAt?: string | null }, onMoved: (stage: Stage) => void) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [client, setClient] = useState('');
  const [date, setDate] = useState(today());

  const run = async (to: Stage, extra: Record<string, unknown> = {}) => {
    setBusy(true); setErr('');
    const r = await postStage(candidate.id, to, extra);
    setBusy(false);
    if (r.ok) { setPending(null); onMoved(to); return; }
    if (r.needsEndDate) { setPending({ to, kind: 'end', placedAt: (r.open ?? []).map((p) => p.client_name).join(', ') }); setDate(today()); return; }
    setErr(r.error ?? 'the stage could not be saved');
  };

  const request = (to: Stage) => {
    if (to === candidate.stage) return;
    setErr('');
    if (to === 'placed') { setPending({ to, kind: 'placement' }); setClient(''); setDate(today()); return; }
    if (candidate.stage === 'placed') { setPending({ to, kind: 'end', placedAt: candidate.placedAt ?? undefined }); setDate(today()); return; }
    run(to);
  };

  const dialog = pending ? (
    <div data-stage-dialog={pending.kind} className="fixed inset-0 z-50 bg-rail/60 grid place-items-center px-4" role="dialog" aria-modal="true">
      <form
        className="w-full max-w-[420px] bg-panel border border-line rounded-card px-5 py-5 grid gap-3 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (pending.kind === 'placement') run('placed', { placement: { client: client.trim(), placed_on: date } });
          else run(pending.to, { ended_on: date });
        }}
      >
        {pending.kind === 'placement' ? (
          <>
            <b className="text-[16px]">Placed — where, and from when?</b>
            <div className="text-ink2">{candidate.name ?? 'This candidate'} is recorded as placed at this client, with you as the one who entered it.</div>
            <label className="grid gap-1"><span className="text-ink3">Client</span>
              <input data-placement-client autoFocus required value={client} onChange={(e) => setClient(e.target.value)} placeholder="e.g. AIBEL" className="border border-line rounded px-3 py-2 bg-panel" /></label>
            <label className="grid gap-1"><span className="text-ink3">Placement starts</span>
              <input data-placement-date type="date" required value={date} onChange={(e) => setDate(e.target.value)} className="border border-line rounded px-3 py-2 bg-panel" /></label>
          </>
        ) : (
          <>
            <b className="text-[16px]">End the placement?</b>
            <div className="text-ink2">{candidate.name ?? 'This candidate'} is placed{pending.placedAt ? ` at ${pending.placedAt}` : ''}. Moving them to {STAGE_LABEL[pending.to]} ends that placement on this date.</div>
            <label className="grid gap-1"><span className="text-ink3">Placement ended</span>
              <input data-placement-end type="date" required value={date} onChange={(e) => setDate(e.target.value)} className="border border-line rounded px-3 py-2 bg-panel" /></label>
          </>
        )}
        {err && <div className="text-bad">{err}</div>}
        <div className="flex gap-2 justify-end flex-wrap">
          <button type="button" className="btn" onClick={() => { setPending(null); setErr(''); }} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy} data-stage-confirm>{busy ? 'Saving…' : pending.kind === 'placement' ? 'Record placement' : `Move to ${STAGE_LABEL[pending.to]}`}</button>
        </div>
      </form>
    </div>
  ) : null;

  return { request, dialog, busy, err };
}

/** A stage picker for a table row or a card — the way a touch screen moves someone, since it cannot drag. */
export function StageSelect({ candidate, disabled, onMoved }: { candidate: { id: string; name: string | null; stage: Stage; placedAt?: string | null }; disabled?: boolean; onMoved: (stage: Stage) => void }) {
  const move = useStageMove(candidate, onMoved);
  return (
    <>
      <select
        data-stage-select={candidate.id}
        aria-label={`Stage for ${candidate.name ?? 'candidate'}`}
        value={candidate.stage}
        disabled={disabled || move.busy}
        onChange={(e) => move.request(e.target.value as Stage)}
        className="border border-line rounded px-2 py-1.5 bg-panel text-[13px] max-w-full"
      >
        {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
      </select>
      {move.err && !move.dialog && <div className="text-bad text-[12px] mt-1">{move.err}</div>}
      {move.dialog}
    </>
  );
}
