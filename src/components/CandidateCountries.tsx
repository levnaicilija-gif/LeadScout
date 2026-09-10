'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EU27 } from '@/lib/geo';

/**
 * Where this workspace's candidates come from.
 *
 * The LinkedIn search reads this, so it is not decoration: it decides who the recruiter is shown
 * for every job. Editable here rather than in code, because it changes with the business and not
 * with a deploy.
 */
const NAME: Record<string, string> = {
  RO: 'Romania', PL: 'Poland', HR: 'Croatia', BG: 'Bulgaria', PT: 'Portugal', LT: 'Lithuania',
  SK: 'Slovakia', HU: 'Hungary', GR: 'Greece', ES: 'Spain', IT: 'Italy', LV: 'Latvia',
  EE: 'Estonia', CZ: 'Czechia', SI: 'Slovenia', DK: 'Denmark', NL: 'Netherlands', DE: 'Germany',
  BE: 'Belgium', SE: 'Sweden', FR: 'France', IE: 'Ireland', FI: 'Finland', AT: 'Austria',
  LU: 'Luxembourg', MT: 'Malta', CY: 'Cyprus', GB: 'United Kingdom', NO: 'Norway', IS: 'Iceland',
};
const ALL = [...new Set([...EU27, 'GB', 'NO', 'IS'])] as string[];

export function CandidateCountries({ initial }: { initial: string[] }) {
  const r = useRouter();
  const [value, setValue] = useState<string[]>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const toggle = (cc: string) => { setSaved(false); setValue(value.includes(cc) ? value.filter((v) => v !== cc) : [...value, cc]); };

  const save = async () => {
    setBusy(true); setErr(''); setSaved(false);
    try {
      const res = await fetch('/api/settings/candidate-countries', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ countries: value }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setSaved(true); r.refresh();
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    setBusy(false);
  };

  const dirty = JSON.stringify(value) !== JSON.stringify(initial);

  return (
    <div className="bg-panel border border-line rounded p-4 mb-4">
      <h2 className="text-[16px] font-semibold">Candidates come from</h2>
      <p className="text-ink3 text-[13px] mt-0.5 mb-2">
        The countries the LinkedIn candidate search looks in. A job in the UK searches the UK first, then these;
        a job in the EU searches its own country and these. Only EU, EEA and UK — anywhere else needs a permit
        the client would have to sponsor.
      </p>
      <div className="flex flex-wrap gap-1">
        {ALL.map((cc) => (
          <button
            key={cc}
            onClick={() => toggle(cc)}
            className={`px-2 py-0.5 rounded border text-[12px] ${value.includes(cc) ? 'border-accent bg-accentsoft text-accent' : 'border-line text-ink2'}`}
          >
            {NAME[cc] ?? cc}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button className="btn btn-primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        {saved && <span className="text-ok text-[13px]">Saved</span>}
        {err && <span className="text-bad text-[13px]">{err}</span>}
        <span className="text-ink3 text-[12px]">{value.length} selected</span>
      </div>
    </div>
  );
}
