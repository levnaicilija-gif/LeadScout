'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PREFERENCES, PREFERENCE_LABEL, type Preference } from '@/lib/candidate-stages';

/**
 * The fields a recruiter edits on a candidate's page (item 24): name, phone, email, trade, country, availability, notes,
 * employment preference and the keep-until date. Saved together; a field the server refuses shows its reason beside it
 * and nothing is half-saved. The phone is checked for shape only — no lookup anywhere.
 */
type Fields = {
  id: string; full_name: string; phone: string; email: string; trade: string; country: string; availability_from: string;
  notes: string; employment_preference: Preference | ''; data_retention_until: string;
};

export function CandidateEditForm({ candidate, crm }: { candidate: Fields; crm: boolean }) {
  const router = useRouter();
  const [v, setV] = useState(candidate);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { setV({ ...v, [k]: e.target.value }); setMsg(''); };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setProblems({}); setMsg('');
    const body: Record<string, string> = { full_name: v.full_name, phone: v.phone, email: v.email, trade: v.trade, availability_from: v.availability_from, notes: v.notes };
    if (crm) Object.assign(body, { country: v.country, employment_preference: v.employment_preference, data_retention_until: v.data_retention_until });
    try {
      const r = await fetch(`/api/candidates/${v.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setProblems(j.problems ?? {}); setMsg(j.error ?? `not saved (HTTP ${r.status})`); return; }
      setMsg('Saved');
      router.refresh();
    } catch (err: any) {
      setMsg(String(err?.message ?? err));
    } finally { setBusy(false); }
  };

  const field = (k: keyof Fields, label: string, input: React.ReactNode) => (
    <label className="grid gap-1" data-edit-field={k}>
      <span className="text-ink3 text-[12px]">{label}</span>
      {input}
      {problems[k] && <span className="text-bad text-[12px]" data-edit-problem={k}>{problems[k]}</span>}
    </label>
  );
  const cls = 'border border-line rounded px-3 py-2 bg-panel text-[13px] w-full min-w-0';

  return (
    <form onSubmit={save} className="grid gap-3" data-candidate-edit>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {field('full_name', 'Name', <input className={cls} value={v.full_name} onChange={set('full_name')} />)}
        {field('trade', 'Trade', <input className={cls} value={v.trade} onChange={set('trade')} />)}
        {field('phone', 'Phone', <input className={cls} inputMode="tel" value={v.phone} onChange={set('phone')} placeholder="+47 912 34 567" />)}
        {field('email', 'Email', <input className={cls} type="email" value={v.email} onChange={set('email')} />)}
        {field('country', 'Based in', <input className={cls} value={v.country} onChange={set('country')} disabled={!crm} placeholder={crm ? 'e.g. Norway' : 'arrives with 0035'} />)}
        {field('availability_from', 'Available from', <input className={cls} type="date" value={v.availability_from} onChange={set('availability_from')} />)}
        {field('employment_preference', 'Employment preference', (
          <select className={cls} value={v.employment_preference} onChange={set('employment_preference')} disabled={!crm}>
            <option value="">{crm ? 'Not stated' : 'arrives with 0035'}</option>
            {PREFERENCES.map((p) => <option key={p} value={p}>{PREFERENCE_LABEL[p]}</option>)}
          </select>
        ))}
        {field('data_retention_until', 'Keep record until', <input className={cls} type="date" value={v.data_retention_until} onChange={set('data_retention_until')} disabled={!crm} />)}
      </div>
      {field('notes', 'Notes', <textarea className={`${cls} min-h-[90px]`} value={v.notes} onChange={set('notes')} />)}
      <div className="flex items-center gap-3">
        <button className="btn btn-primary" disabled={busy} data-edit-save>{busy ? 'Saving…' : 'Save'}</button>
        {msg && <span className={msg === 'Saved' ? 'text-ok text-[13px]' : 'text-bad text-[13px]'} data-edit-message>{msg}</span>}
      </div>
    </form>
  );
}
