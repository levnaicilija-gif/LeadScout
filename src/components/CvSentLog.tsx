'use client';
import { useState } from 'react';
import { sendKind, sendDateLabel } from '@/lib/cv-sent-entry';

/**
 * The CVs sent to clients for one candidate (item 24): an appendable log — which client, when, who logged it — and a form
 * to add to it. Nothing here edits or removes an entry. Before 0035 the log is shown read-only.
 *
 * A pack prepared for a lead ("Send to this lead") has no sent date by design and is shown as a pack, never as a CV sent
 * on 01/01/1970 (src/lib/cv-sent-entry.ts).
 */
export type SentEntry = { id: string; client: string; sentAt: string | null; by: string; note: string | null };

export function CvSentLog({ candidateId, enabled, initial }: { candidateId: string; enabled: boolean; initial: SentEntry[] }) {
  const [entries, setEntries] = useState(initial);
  const [client, setClient] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/candidates/${candidateId}/sends`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client, sent_on: date, note: note || undefined }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error ?? `not logged (HTTP ${r.status})`); return; }
      setEntries([{ id: j.send.id, client: j.send.client_name, sentAt: j.send.sent_at, by: 'you', note: j.send.note }, ...entries]);
      setClient(''); setNote('');
    } catch (x: any) {
      setErr(String(x?.message ?? x));
    } finally { setBusy(false); }
  };

  const cls = 'border border-line rounded px-3 py-2 bg-panel text-[13px] min-w-0';
  return (
    <div className="grid gap-3 text-[13px]" data-cv-sent-log>
      {entries.length === 0 ? <div className="text-ink3">No CV sent yet.</div> : (
        <ul className="list-none m-0 p-0 grid gap-1.5">
          {entries.map((s) => {
            const pack = sendKind(s.sentAt) === 'prepared';
            return (
              <li key={s.id} data-cv-sent-entry={pack ? 'pack' : 'sent'} className="border border-line2 rounded px-3 py-2">
                <b className="font-semibold">{s.client}</b> · {pack ? 'pack prepared for a lead, not marked sent' : sendDateLabel(s.sentAt)}
                <div className="text-ink3 text-[12px]">{pack ? `${sendDateLabel(s.sentAt)} · prepared by ${s.by}` : `logged by ${s.by}`}{s.note ? ` · ${s.note}` : ''}</div>
              </li>
            );
          })}
        </ul>
      )}
      {enabled ? (
        <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_150px] gap-2" data-cv-sent-form>
          <input className={cls} required value={client} onChange={(e) => setClient(e.target.value)} placeholder="Client, e.g. Semco Maritime" data-cv-sent-client />
          <input className={cls} type="date" required value={date} onChange={(e) => setDate(e.target.value)} data-cv-sent-date />
          <input className={`${cls} sm:col-span-2`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
          <div className="sm:col-span-2 flex items-center gap-3">
            <button className="btn btn-primary" disabled={busy} data-cv-sent-add>{busy ? 'Logging…' : 'Log CV sent'}</button>
            {err && <span className="text-bad">{err}</span>}
          </div>
        </form>
      ) : <div className="text-ink3 text-[12px]">Logging a CV sent arrives with migration 0035.</div>}
    </div>
  );
}
