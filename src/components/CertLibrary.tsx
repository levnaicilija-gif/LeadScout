'use client';
import { useEffect, useState } from 'react';

/**
 * The certificate library, and the certificates nothing can explain yet.
 *
 * Two halves of one job. The queue at the top is the work: a ticket arrived, nobody could say
 * what it covers, and until a senior writes it down every card and every client pack will keep
 * saying "unrecognised — check". Writing it once fixes all of them, retrospectively.
 *
 * A shipped entry is never edited in place. Saving writes this workspace's own row, which
 * shadows ours — so a better entry can ship later without overwriting what RFBT has learned,
 * and a bad edit is undone with Reset rather than by remembering what the original said.
 */
type Entry = {
  id: string; workspace_id: string | null; body: string; level: string | null; title: string;
  meaning: string; covers?: string | null; not_covered?: string | null; who_requires?: string | null;
  typical_validity?: string | null; verification_route?: string | null; trades?: string[] | null; source?: string | null;
};
type Unknown = { id: string; body: string; level: string | null; seen_count: number; first_seen_at: string; last_seen_at: string };

const FIELDS: [keyof Entry, string, string][] = [
  ['title', 'Title', 'PCN Level 2'],
  ['meaning', 'What it says', 'Certification to ISO 9712 issued by BINDT…'],
  ['covers', 'What the holder can do', 'One statement per line.'],
  ['not_covered', 'What it does not cover', 'One statement per line.'],
  ['who_requires', 'Who asks for it', 'Fabrication yards, pipeline contractors…'],
  ['typical_validity', 'Typical validity', '5 years, with recertification at 10 years.'],
  ['verification_route', 'How it is checked', 'BINDT public register, by certificate number.'],
];

export function CertLibrary({ senior }: { senior: boolean }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [unknown, setUnknown] = useState<Unknown[]>([]);
  const [editing, setEditing] = useState<Partial<Entry> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    const j = await fetch('/api/cert-library').then((r) => r.json()).catch(() => null);
    if (!j) { setReady(false); return; }
    setReady(!!j.ready); setEntries(j.entries ?? []); setUnknown(j.unknown ?? []);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing?.body || !editing.title || !editing.meaning) { setErr('A body, a title and a meaning are the minimum — an entry that says nothing is worse than none.'); return; }
    setBusy(true); setErr('');
    const r = await fetch('/api/cert-library', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: editing.body, level: editing.level || null, patch: editing }),
    });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) { setErr(j?.error ?? 'could not save'); return; }
    setEditing(null); load();
  };

  const reset = async (e: Entry) => {
    setBusy(true);
    await fetch('/api/cert-library', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'reset', body: e.body, level: e.level }),
    });
    setBusy(false); load();
  };

  if (ready === null) return <div className="text-ink3 text-[13px]">Reading the library…</div>;
  if (!ready) return <div className="text-ink3 text-[13px]">The certificate library arrives with migration 0019, which has not been applied here yet.</div>;

  // A workspace row hides the shipped row it shadows, so the list shows what is actually in use.
  const shown = entries.filter((e) => e.workspace_id || !entries.some((o) => o.workspace_id && o.body === e.body && (o.level ?? '') === (e.level ?? '')));

  return (
    <div className="grid gap-4">
      {/* ---- the queue */}
      <div className={`border rounded-card ${unknown.length ? 'border-warn bg-warnsoft' : 'border-line bg-panel'} px-4 py-3`}>
        <b className="font-semibold">
          {unknown.length ? `${unknown.length} certificate${unknown.length === 1 ? '' : 's'} nobody can explain yet` : 'Every certificate seen so far can be explained'}
        </b>
        <div className="text-ink2 text-[12px] mt-0.5">
          {unknown.length
            ? 'Until one is written up, its card and every client pack say "unrecognised — check". Adding it explains it everywhere, including packs already sent out again.'
            : 'A certificate arriving that the tables do not know will appear here.'}
        </div>
        {unknown.length > 0 && (
          <div className="grid gap-1.5 mt-2.5">
            {unknown.map((u) => (
              <div key={u.id} className="flex items-center gap-3 flex-wrap bg-panel border border-line rounded px-3 py-2 text-[13px]">
                <b className="font-semibold">{u.body}{u.level ? ` · ${u.level}` : ''}</b>
                <span className="text-ink3 text-[12px]">seen {u.seen_count}× · first {new Date(u.first_seen_at).toLocaleDateString('en-GB')}</span>
                <div className="flex-1" />
                {senior
                  ? <button className="btn text-[13px]" onClick={() => setEditing({ body: u.body, level: u.level ?? '', title: '', meaning: '' })}>Add to the library</button>
                  : <span className="text-ink3 text-[12px]">a senior adds this</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- the editor */}
      {editing && (
        <div className="border border-line rounded-card bg-panel p-4">
          <div className="flex gap-2 flex-wrap items-end">
            <label className="text-[12px] text-ink3 font-semibold">Body
              <input value={editing.body ?? ''} onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                className="block border border-line rounded px-2.5 py-2 mt-1 text-[13px] text-ink font-normal" placeholder="pcn" />
            </label>
            <label className="text-[12px] text-ink3 font-semibold">Level <span className="font-normal">(blank = the scheme itself)</span>
              <input value={editing.level ?? ''} onChange={(e) => setEditing({ ...editing, level: e.target.value })}
                className="block border border-line rounded px-2.5 py-2 mt-1 text-[13px] text-ink font-normal" placeholder="2" />
            </label>
          </div>
          {FIELDS.map(([k, label, ph]) => (
            <label key={k} className="block text-[12px] text-ink3 font-semibold mt-3">{label}
              <textarea
                value={(editing[k] as string) ?? ''}
                onChange={(e) => setEditing({ ...editing, [k]: e.target.value })}
                rows={k === 'meaning' || k === 'covers' || k === 'not_covered' ? 3 : 1}
                placeholder={ph}
                className="block w-full border border-line rounded px-2.5 py-2 mt-1 text-[13px] text-ink font-normal"
              />
            </label>
          ))}
          {err && <div className="text-bad text-[13px] mt-2">{err}</div>}
          <div className="flex gap-2 mt-3">
            <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save to your library'}</button>
            <button className="btn" onClick={() => { setEditing(null); setErr(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* ---- what is in use */}
      <div className="bg-panel border border-line rounded-card overflow-auto">
        <table className="tbl w-full min-w-[820px]">
          <thead><tr><th>Certificate</th><th>What it says</th><th>Validity</th><th>Checked</th><th>Source</th><th /></tr></thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id}>
                <td>
                  <div className="font-medium whitespace-nowrap">{e.title}</div>
                  <div className="text-ink3 text-[12px]">{e.body}{e.level ? ` · ${e.level}` : ''}</div>
                </td>
                <td className="max-w-[420px]">{e.meaning}</td>
                <td className="whitespace-nowrap">{e.typical_validity ?? '—'}</td>
                <td>{e.verification_route ?? '—'}</td>
                <td>
                  <span className={`badge ${e.workspace_id ? 'badge-info' : 'badge-ok'}`}>{e.workspace_id ? 'yours' : 'shipped'}</span>
                  {e.source?.includes('senior must confirm') && <div className="text-warn text-[12px] mt-1">{e.source.replace(/^shipped — /, '')}</div>}
                </td>
                <td className="whitespace-nowrap">
                  {senior && (
                    <span className="flex gap-1.5">
                      <button className="btn text-[12px]" onClick={() => setEditing({ ...e, level: e.level ?? '' })}>Edit</button>
                      {e.workspace_id && <button className="btn text-[12px]" disabled={busy} onClick={() => reset(e)}>Reset</button>}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={6} className="p-6 text-ink3">Nothing in the library yet — run scripts/seed-certs.ts.</td></tr>}
          </tbody>
        </table>
      </div>
      {senior && !editing && <div><button className="btn" onClick={() => setEditing({ body: '', level: '', title: '', meaning: '' })}>Add a certificate</button></div>}
    </div>
  );
}
