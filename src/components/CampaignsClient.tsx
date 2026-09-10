'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Campaigns, and what each person on one still owes.
 *
 * A document counts as held only when a file of that type is on the candidate. Nothing here can
 * be ticked by hand: the whole point is that "he says he has a medical" and "there is a medical
 * on file" are different facts, and only the second one puts somebody on a plane.
 */
const DOC_LABEL: Record<string, string> = {
  passport: 'Passport', medical: 'Medical', certificate: 'Certificate', a1: 'A1',
  cv: 'CV', test_report: 'Test report', contract: 'Contract', other: 'Other',
};
const OFFERED = ['passport', 'medical', 'certificate', 'a1', 'contract'];

type Campaign = {
  id: string; name: string; site: string | null; country: string | null;
  starts_on: string | null; ends_on: string | null; required_docs: string[] | null; status: string;
  companies: { name: string } | null;
  campaign_candidates: { candidate_id: string; candidates: any }[];
};

const day = (s?: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null);

export function CampaignsClient({ campaigns, candidates, companies, held, senior }: {
  campaigns: Campaign[];
  candidates: any[];
  companies: { id: string; name: string }[];
  held: Record<string, string[]>;
  senior?: boolean;
}) {
  const r = useRouter();
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<any>({ name: '', company_id: '', site: '', starts_on: '', required_docs: ['passport', 'medical', 'certificate', 'a1'] });
  const [adding, setAdding] = useState<string | null>(null);

  const call = async (body: any, what: string) => {
    setBusy(what); setErr('');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const res = await fetch('/api/campaign', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal, body: JSON.stringify(body) });
      const text = await res.text();
      let j: any = null;
      try { j = text ? JSON.parse(text) : null; } catch { /* an error page, not JSON */ }
      if (!res.ok || !j) { setErr(j?.error ?? `That did not work (HTTP ${res.status}).`); return null; }
      r.refresh();
      return j;
    } catch (e: any) {
      setErr(e?.name === 'AbortError' ? 'That took longer than 60 seconds and was stopped.' : 'Could not reach the server.');
      return null;
    } finally { clearTimeout(timer); setBusy(''); }
  };

  const create = async () => {
    if (!form.name.trim()) { setErr('A campaign needs a name.'); return; }
    const j = await call({ action: 'create', ...form, company_id: form.company_id || null }, 'create');
    if (j) { setCreating(false); setForm({ ...form, name: '', site: '', starts_on: '' }); }
  };

  return (<>
    {err && <div className="text-bad text-[13px] mb-2">{err}</div>}

    {senior && (creating ? (
      <div className="bg-panel border border-line rounded p-4 mb-4">
        <h2 className="text-[15px] font-semibold mb-2">New campaign</h2>
        <div className="grid grid-cols-2 gap-2 max-w-[720px]">
          <input className="border border-line rounded px-2 py-1" placeholder="Name, e.g. Esbjerg blade repair, Q4" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select className="border border-line rounded px-2 py-1" value={form.company_id} onChange={(e) => setForm({ ...form, company_id: e.target.value })}>
            <option value="">Client — optional</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="border border-line rounded px-2 py-1" placeholder="Site, e.g. Esbjerg" value={form.site} onChange={(e) => setForm({ ...form, site: e.target.value })} />
          <label className="flex items-center gap-2 text-[13px] text-ink3">Starts
            <input type="date" className="border border-line rounded px-2 py-1 flex-1" value={form.starts_on} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} />
          </label>
        </div>
        <div className="mt-2">
          <div className="text-[12px] text-ink3 mb-1">Documents each person must have before they travel</div>
          <div className="flex gap-1 flex-wrap">
            {OFFERED.map((d) => (
              <button key={d} onClick={() => setForm({ ...form, required_docs: form.required_docs.includes(d) ? form.required_docs.filter((x: string) => x !== d) : [...form.required_docs, d] })}
                className={`px-2 py-0.5 rounded border text-[12px] ${form.required_docs.includes(d) ? 'border-accent bg-accentsoft text-accent' : 'border-line text-ink2'}`}>
                {DOC_LABEL[d]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          <button className="btn btn-primary" disabled={busy === 'create'} onClick={create}>{busy === 'create' ? 'Creating…' : 'Create campaign'}</button>
          <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
        </div>
      </div>
    ) : <button className="btn btn-primary mb-4" onClick={() => setCreating(true)}>New campaign</button>)}

    {campaigns.length === 0 && (
      <div className="bg-panel border border-line rounded p-6 text-ink3">
        No campaigns yet. A campaign is a batch of people going to one client — create one and Today will tell you who is still missing a document.
      </div>
    )}

    <div className="grid gap-3">
      {campaigns.map((c) => {
        const required = c.required_docs ?? [];
        const people = (c.campaign_candidates ?? []).map((cc) => cc.candidates).filter(Boolean);
        const startsIn = c.starts_on ? Math.ceil((Date.parse(c.starts_on) - Date.now()) / 86400000) : null;
        const short = people.filter((p: any) => required.some((d) => !(held[p.id] ?? []).includes(d)));

        return (
          <div key={c.id} className="bg-panel border border-line rounded">
            <div className="px-4 py-3 border-b border-line2 flex items-baseline justify-between flex-wrap gap-2">
              <div>
                <b className="text-[15px] font-semibold">{c.name}</b>
                <div className="text-ink3 text-[12px]">
                  {[c.companies?.name, c.site, c.country].filter(Boolean).join(' · ') || 'No client on this campaign yet'}
                  {c.starts_on && <> · starts {day(c.starts_on)}{startsIn !== null && startsIn >= 0 ? ` (in ${startsIn} day${startsIn === 1 ? '' : 's'})` : ''}</>}
                </div>
              </div>
              <div className="text-[13px]">
                {short.length === 0
                  ? <span className="text-ok">{people.length ? 'Everyone has their documents' : 'Nobody on this campaign yet'}</span>
                  : <span className={startsIn !== null && startsIn <= 21 ? 'text-bad' : 'text-warn'}>{short.length} of {people.length} short of a document</span>}
              </div>
            </div>

            <div className="px-4 py-2 text-[12px] text-ink3 border-b border-line2">
              Required: {required.map((d) => DOC_LABEL[d] ?? d).join(', ') || 'nothing set'}
            </div>

            {people.length > 0 && (
              <table className="tbl w-full">
                <thead><tr><th>Candidate</th><th>Trade</th><th>Free from</th><th>Missing</th><th /></tr></thead>
                <tbody>
                  {people.map((p: any) => {
                    const missing = required.filter((d) => !(held[p.id] ?? []).includes(d));
                    return (
                      <tr key={p.id}>
                        <td><b className="font-medium">{p.reference_code}</b><div className="text-ink3 text-[12px]">{p.full_name}</div></td>
                        <td className="text-[13px]">{p.trade ?? '—'}</td>
                        <td className="text-[13px]">{p.availability_from ? day(p.availability_from) : 'now'}</td>
                        <td className="text-[13px]">
                          {missing.length === 0
                            ? <span className="text-ok">all on file</span>
                            : <span className="text-warn">{missing.map((d) => DOC_LABEL[d] ?? d).join(', ')}</span>}
                        </td>
                        <td className="text-right">
                          <button className="btn text-[12px]" disabled={!!busy} onClick={() => call({ action: 'remove', campaign_id: c.id, candidate_id: p.id }, `rm-${p.id}`)}>Remove</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <div className="px-4 py-2.5 border-t border-line2">
              {adding === c.id ? (
                <div className="flex gap-2 items-center flex-wrap">
                  <select className="border border-line rounded px-2 py-1 text-[13px]" id={`add-${c.id}`}>
                    <option value="">Choose a candidate…</option>
                    {candidates.filter((x) => !people.some((p: any) => p.id === x.id)).map((x) => (
                      <option key={x.id} value={x.id}>{x.reference_code} — {x.trade ?? 'trade not stated'}</option>
                    ))}
                  </select>
                  <button className="btn btn-primary text-[12px]" disabled={!!busy} onClick={() => {
                    const v = (document.getElementById(`add-${c.id}`) as HTMLSelectElement)?.value;
                    if (v) call({ action: 'add', campaign_id: c.id, candidate_ids: [v] }, `add-${c.id}`);
                  }}>Add</button>
                  <button className="btn text-[12px]" onClick={() => setAdding(null)}>Done</button>
                </div>
              ) : <button className="btn text-[12px]" onClick={() => setAdding(c.id)}>Add a candidate</button>}
            </div>
          </div>
        );
      })}
    </div>
  </>);
}
