'use client';
import { useEffect, useState } from 'react';

type Member = { id: string; name: string | null; role: string; industry_follow: string[] | null; industry_limit: number | null; canFollowAll: boolean; industry_follow_set_at: string | null };
type Option = { id: string; label: string };

/**
 * Settings · what the team follows (item 18 part 3). A senior reads every member's industries and can adjust one for
 * them. What a member may follow is their own entitlement, read on the server; this only asks, and shows a refusal
 * exactly as the server gave it.
 */
export function TeamIndustries({ options }: { options: Option[] }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await fetch('/api/team/industries');
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setLoadError(j.error ?? `The team could not be read (HTTP ${r.status}).`); return; }
    setMembers(j.members ?? []);
  };
  useEffect(() => { load(); }, []);

  const label = (id: string) => (id === 'all' ? 'All industries' : options.find((o) => o.id === id)?.label ?? id);
  const save = async (m: Member) => {
    setBusy(true); setSaveError('');
    const r = await fetch('/api/team/industries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: m.id, follow: picked }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setSaveError(j.error ?? `Not saved (HTTP ${r.status}).`); return; }
    setEditing(null);
    load();
  };

  if (loadError) return <p className="text-bad text-[13px]">{loadError}</p>;
  if (!members) return <p className="text-ink3 text-[13px]">Reading the team…</p>;
  return (
    <div data-team-industries className="bg-panel border border-line rounded-card overflow-auto">
      <table className="tbl w-full">
        <thead><tr><th>Member</th><th>Follows</th><th>May follow</th><th></th></tr></thead>
        <tbody>{members.map((m) => (
          <tr key={m.id} data-member={m.id}>
            <td><div className="font-medium">{m.name ?? '—'}</div><div className="text-ink3 text-[12px]">{m.role}</div></td>
            <td className="text-[13px]">{editing === m.id ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {m.canFollowAll && <label className="flex gap-2 items-center"><input type="checkbox" checked={picked.includes('all')} onChange={() => setPicked(picked.includes('all') ? [] : ['all'])} />All industries</label>}
                {options.map((o) => <label key={o.id} className="flex gap-2 items-center"><input type="checkbox" checked={picked.includes(o.id)} onChange={() => setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p.filter((x) => x !== 'all'), o.id]))} />{o.label}</label>)}
                {saveError && <p data-team-error className="text-bad text-[12px] sm:col-span-2">{saveError}</p>}
              </div>
            ) : (m.industry_follow?.length ? m.industry_follow.map(label).join(', ') : <span className="text-ink3">not chosen yet</span>)}</td>
            <td className="text-[13px] whitespace-nowrap">{m.industry_limit == null ? 'any number' : `up to ${m.industry_limit}`}</td>
            <td className="whitespace-nowrap">{editing === m.id
              ? <><button className="btn btn-primary" disabled={busy || !picked.length} onClick={() => save(m)}>{busy ? 'Saving…' : 'Save'}</button> <button className="btn" onClick={() => { setEditing(null); setSaveError(''); }}>Cancel</button></>
              : <button className="btn" data-edit-member onClick={() => { setEditing(m.id); setPicked(m.industry_follow ?? []); setSaveError(''); }}>Adjust</button>}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
