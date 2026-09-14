'use client';
import { useState } from 'react';

export type OnboardingOption = { id: string; label: string; leads: number | null; hiring: number | null };

/**
 * The industry choice, at onboarding and in Preferences. It only asks: the server decides what is allowed
 * (/api/me/industries, 0032's trigger), and whatever it refuses is shown as it said it.
 */
export function IndustryOnboarding({ options, limit, canFollowAll, initial = [], saveLabel = 'Continue', after = '/app/radar' }: {
  options: OnboardingOption[]; limit: number | null; canFollowAll: boolean; initial?: string[]; saveLabel?: string; after?: string;
}) {
  const [picked, setPicked] = useState<string[]>(initial.filter((i) => i !== 'all'));
  const [all, setAll] = useState(initial.includes('all') && canFollowAll);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const counted = options.some((o) => o.leads != null);
  const chosen = all ? ['all'] : picked;
  const matches = all ? null : options.filter((o) => picked.includes(o.id)).reduce((n, o) => n + (o.leads ?? 0) + (o.hiring ?? 0), 0);

  const toggle = (id: string) => { setAll(false); setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])); };
  const save = async () => {
    setBusy(true); setError('');
    const r = await fetch('/api/me/industries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ follow: chosen }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setError(j.error ?? `Not saved (HTTP ${r.status}).`); setBusy(false); return; }
    window.location.href = after;
  };

  return (
    <div data-industry-choice className="mt-6">
      <p className="text-[13px] text-ink3 mb-3">{limit != null ? `Choose up to ${limit}.` : 'Choose as many as you work in.'}{counted ? ' Beside each: open won-work leads · companies hiring, on file today.' : ''}</p>
      {canFollowAll && (
        <label data-option="all" className={`flex items-center gap-3 border rounded-card px-4 py-3 mb-3 cursor-pointer ${all ? 'border-accent bg-accentsoft' : 'border-line bg-panel'}`}>
          <input type="checkbox" checked={all} onChange={() => { setAll(!all); if (!all) setPicked([]); }} />
          <span className="font-medium">All industries</span>
        </label>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {options.map((o) => (
          <label key={o.id} data-option={o.id} className={`flex items-start gap-3 border rounded-card px-4 py-3 cursor-pointer ${picked.includes(o.id) ? 'border-accent bg-accentsoft' : 'border-line bg-panel'}`}>
            <input type="checkbox" className="mt-1" checked={picked.includes(o.id)} onChange={() => toggle(o.id)} />
            <span className="min-w-0"><span className="font-medium block">{o.label}</span>{o.leads != null && <span className="text-[12px] text-ink3">{o.leads} lead{o.leads === 1 ? '' : 's'} · {o.hiring} hiring</span>}</span>
          </label>
        ))}
      </div>
      {!all && picked.length > 0 && counted && matches === 0 && (
        <p data-no-matches className="mt-3 text-[13px] text-warn">Nothing on file in {picked.length === 1 ? 'this industry' : 'these industries'} yet. You will see everything else until something arrives — or choose another as well.</p>
      )}
      {error && <p data-choice-error className="mt-3 text-[13px] text-bad">{error}</p>}
      <button type="button" data-save-industries className="btn btn-primary mt-5" disabled={busy || chosen.length === 0} onClick={save}>{busy ? 'Saving…' : saveLabel}</button>
    </div>
  );
}
