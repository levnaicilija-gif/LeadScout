'use client';
import { useState } from 'react';
import { EU27 } from '@/lib/geo';

/**
 * Which countries a LinkedIn search looks in.
 *
 * The default follows the job — an EU scope draws on the EU and Norway, a UK scope looks in the
 * UK first — because the old fixed list started with Serbia, and a Serbian welder needs a permit
 * no client sponsors for a six-week job. A recruiter who knows better can still change it, which
 * is what this is for.
 */
const NAME: Record<string, string> = {
  GB: 'United Kingdom', NO: 'Norway', IS: 'Iceland', RO: 'Romania', PL: 'Poland', HR: 'Croatia',
  BG: 'Bulgaria', PT: 'Portugal', LT: 'Lithuania', SK: 'Slovakia', HU: 'Hungary', GR: 'Greece',
  ES: 'Spain', IT: 'Italy', DK: 'Denmark', NL: 'Netherlands', DE: 'Germany', BE: 'Belgium',
  SE: 'Sweden', FR: 'France', IE: 'Ireland', FI: 'Finland', EE: 'Estonia', LV: 'Latvia',
  CZ: 'Czechia', SI: 'Slovenia', AT: 'Austria', LU: 'Luxembourg', MT: 'Malta', CY: 'Cyprus',
};

const ALL = [...new Set([...EU27, 'GB', 'NO', 'IS'])] as string[];

export function CountryPicker({ value, onChange, jobCountry }: {
  value: string[];
  onChange: (v: string[]) => void;
  jobCountry?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (cc: string) => onChange(value.includes(cc) ? value.filter((v) => v !== cc) : [...value, cc]);

  return (
    <div className="mt-2 text-[12px]">
      <button className="text-accent" onClick={() => setOpen(!open)}>
        {value.length
          ? `Searching ${value.length} ${value.length === 1 ? 'country' : 'countries'}: ${value.slice(0, 4).map((c) => NAME[c] ?? c).join(', ')}${value.length > 4 ? '…' : ''}`
          : `Countries follow the job${jobCountry ? ` (${NAME[jobCountry] ?? jobCountry})` : ''} — change`}
        <span className="text-ink3"> · {open ? 'close' : 'change'}</span>
      </button>

      {open && (
        <div className="border border-line rounded p-2 mt-1 bg-[#FAFBFC]">
          <div className="flex flex-wrap gap-1">
            {ALL.map((cc) => (
              <button
                key={cc}
                onClick={() => toggle(cc)}
                className={`px-1.5 py-0.5 rounded border text-[12px] ${value.includes(cc) ? 'border-accent bg-accentsoft text-accent' : 'border-line text-ink2'}`}
              >
                {NAME[cc] ?? cc}
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button className="text-ink3" onClick={() => onChange([])}>Back to the job&apos;s own default</button>
          </div>
          <div className="text-ink3 mt-1">Only EU, EEA and UK are offered: anywhere else needs a permit the client would have to sponsor.</div>
        </div>
      )}
    </div>
  );
}
