'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * "This is an EPC contractor, not an agency."
 *
 * Worley, Subsea 7, Boskalis and seventeen others were filed as competitors and hidden from
 * Hiring now. A keyword put them there and only a person can take them out, so the control sits
 * wherever the company is being looked at — and says what the detector thought, so the recruiter
 * can see what they are overruling.
 */
const LABEL: Record<string, string> = {
  end_client: 'End client',
  epc_contractor: 'EPC contractor',
  staffing_agency: 'Staffing agency',
  unknown: 'Unknown',
};

export function EmployerTypeOverride({ companyId, detected, override, setAt }: {
  companyId: string;
  detected?: string | null;
  override?: string | null;
  setAt?: string | null;
}) {
  const r = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const effective = override ?? detected ?? 'unknown';

  const set = async (type: string | null) => {
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/company/employer-type', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company_id: companyId, employer_type: type }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      r.refresh();
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    setBusy(false);
  };

  return (
    <div className="text-[13px]">
      <div className="text-[12px] text-ink3 mb-1">
        This company is <b className="font-medium text-ink2">{LABEL[effective] ?? effective}</b>
        {override
          ? <span className="text-ok"> · set by hand{setAt ? ` on ${new Date(setAt).toLocaleDateString('en-GB')}` : ''}</span>
          : <span> · from the name</span>}
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {(['end_client', 'epc_contractor', 'staffing_agency'] as const).map((t) => (
          <button
            key={t}
            disabled={busy}
            onClick={() => set(t)}
            className={`btn text-[12px] ${effective === t ? 'border-accent bg-accentsoft text-accent' : ''}`}
          >
            {LABEL[t]}
          </button>
        ))}
        {override && <button className="btn text-[12px] text-ink3" disabled={busy} onClick={() => set(null)}>Clear</button>}
      </div>
      {err && <div className="text-bad text-[12px] mt-1">{err}</div>}
    </div>
  );
}
