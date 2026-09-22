'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Campaigns, and what each person on one still owes.
 *
 * A document counts as received only when a file of that type is on the candidate. Nothing here can
 * be ticked by hand: the whole point is that "he says he has a medical" and "there is a medical
 * on file" are different facts, and only the second one puts somebody on a plane.
 *
 * Since 2026-09-21 a cell says more than held-or-not, and NOT the same states for every type — only a
 * certificate has an issuer's register behind it, so only a certificate can read verified or expired.
 * A passport says "received · no register", which is the whole truth about a passport: there is
 * nowhere to check it. The states and the ready-to-send rule are computed in src/lib/campaign-docs.ts
 * and passed in; this file renders them and decides nothing.
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

/** One required document for one person, as src/lib/campaign-docs.ts computed it. */
type DocStatus = { type: string; state: 'missing' | 'received' | 'verified' | 'expired'; verifiable: boolean; why: string; expiresOn: string | null };
type Cell = { statuses: DocStatus[]; ready: boolean; blockers: string[] };

/**
 * How a state reads. ok/warn/bad say how a fact STANDS — never which tool it belongs to
 * (CLAUDE.md) — so verified is ok, a gap is bad, and "received, and that is as far as this type
 * goes" is deliberately neutral rather than a warning about something nobody can fix.
 */
const STATE_TONE: Record<DocStatus['state'], string> = {
  verified: 'text-ok', received: 'text-ink2', missing: 'text-bad', expired: 'text-bad',
};
const stateWord = (s: DocStatus) => (s.state === 'received' && !s.verifiable ? 'received' : s.state);

export function CampaignsClient({ campaigns, candidates, companies, cells, readyBy, senior }: {
  campaigns: Campaign[];
  candidates: any[];
  companies: { id: string; name: string }[];
  cells: Record<string, Cell>;
  readyBy: Record<string, number>;
  senior?: boolean;
}) {
  const r = useRouter();
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<any>({ name: '', company_id: '', site: '', starts_on: '', required_docs: ['passport', 'medical', 'certificate', 'a1'] });
  const [adding, setAdding] = useState<string | null>(null);
  const [packed, setPacked] = useState('');

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

  /**
   * Prepare a pack for the people this campaign has cleared.
   *
   * send-pack answers 409 with needsAcknowledgement when a candidate carries a certificate that is
   * unverified, expired or pending — ANY certificate, not only the ones this campaign requires — and
   * the recruiter has to say they have seen the list before it goes. That acknowledgement is recorded
   * with the pack. It is asked here rather than suppressed, even though the campaign already called
   * these people ready: ready means their required documents are in order, not that nothing else on
   * their file is worth knowing before their CV reaches a client.
   */
  const sendPacks = async (c: Campaign, candidateIds: string[], acknowledged = false) => {
    if (!candidateIds.length) return;
    setBusy(`pack-${c.id}`); setErr('');
    try {
      const res = await fetch('/api/leads/send-pack', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ campaign_id: c.id, candidate_ids: candidateIds, acknowledge_warnings: acknowledged }),
      });
      const j = await res.json().catch(() => null);
      if (res.status === 409 && j?.needsAcknowledgement) {
        const ok = window.confirm(`Before these go out:\n\n${(j.warnings ?? []).join('\n')}\n\nPrepare ${(j.included ?? []).length} pack(s) anyway?`);
        if (ok) await sendPacks(c, candidateIds, true);
        return;
      }
      if (!res.ok || !j?.ok) { setErr(j?.error ?? `That did not work (HTTP ${res.status}).`); return; }
      setErr('');
      setPacked(`${(j.attached ?? []).length} pack${(j.attached ?? []).length === 1 ? '' : 's'} prepared${j.target?.client ? ` for ${j.target.client}` : ''} — nothing has been emailed. Send them from the lead's outreach.`);
      r.refresh();
    } catch {
      setErr('Could not reach the server.');
    } finally { setBusy(''); }
  };

  const create = async () => {
    if (!form.name.trim()) { setErr('A campaign needs a name.'); return; }
    const j = await call({ action: 'create', ...form, company_id: form.company_id || null }, 'create');
    if (j) { setCreating(false); setForm({ ...form, name: '', site: '', starts_on: '' }); }
  };

  return (<>
    {err && <div className="text-bad text-[13px] mb-2">{err}</div>}
    {packed && <div className="text-ok text-[13px] mb-2" data-packed>{packed}</div>}

    {senior && (creating ? (
      <div className="bg-panel border border-line rounded-card p-4 mb-4">
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
      <div className="bg-panel border border-line rounded-card p-6 text-ink3">
        No campaigns yet. A campaign is a batch of people going to one client — create one and Today will tell you who is still missing a document.
      </div>
    )}

    <div className="grid gap-3">
      {campaigns.map((c) => {
        const required = c.required_docs ?? [];
        const people = (c.campaign_candidates ?? []).map((cc) => cc.candidates).filter(Boolean);
        const startsIn = c.starts_on ? Math.ceil((Date.parse(c.starts_on) - Date.now()) / 86400000) : null;
        const cellFor = (pid: string): Cell => cells[`${c.id}:${pid}`] ?? { statuses: [], ready: false, blockers: ['not read'] };
        const short = people.filter((p: any) => !cellFor(p.id).ready);
        const readyCount = readyBy[c.id] ?? 0;

        return (
          <div key={c.id} className="bg-panel border border-line rounded-card min-w-0">
            <div className="px-4 py-3 border-b border-line2 flex items-baseline justify-between flex-wrap gap-2">
              <div>
                <b className="text-[15px] font-semibold">{c.name}</b>
                <div className="text-ink3 text-[12px]">
                  {[c.companies?.name, c.site, c.country].filter(Boolean).join(' · ') || 'No client on this campaign yet'}
                  {c.starts_on && <> · starts {day(c.starts_on)}{startsIn !== null && startsIn >= 0 ? ` (in ${startsIn} day${startsIn === 1 ? '' : 's'})` : ''}</>}
                </div>
              </div>
              <div className="text-[13px] text-right">
                {people.length === 0
                  ? <span className="text-ok">Nobody on this campaign yet</span>
                  : <>
                      {/* The count a recruiter acts on: how many packs could go today. */}
                      <div data-ready-count={readyCount} data-people-count={people.length}>
                        <span className={readyCount === people.length ? 'text-ok' : 'text-ink2'}><b>{readyCount}</b> of {people.length} ready to send</span>
                      </div>
                      {short.length > 0 && (
                        <div className={`text-[12px] ${startsIn !== null && startsIn <= 21 ? 'text-bad' : 'text-warn'}`}>
                          {short.length} short of something
                        </div>
                      )}
                    </>}
              </div>
            </div>

            <div className="px-4 py-2 text-[12px] text-ink3 border-b border-line2">
              Required: {required.map((d) => DOC_LABEL[d] ?? d).join(', ') || 'nothing set'}
            </div>

            {/* One column per required document, so this table grows with the campaign and no longer
                fits a phone. Scrolled inside its own card, the way the Candidates table already is,
                rather than dropping columns: on a 390px screen a recruiter still needs to see WHICH
                document is the one missing, and a hidden column would answer "somebody is short"
                with nothing about what. */}
            {people.length > 0 && (
              <div className="overflow-x-auto">
              <table className="tbl w-full">
                <thead>
                  <tr>
                    <th>Candidate</th><th>Trade</th><th>Free from</th>
                    {required.map((d) => <th key={d}>{DOC_LABEL[d] ?? d}</th>)}
                    <th>Pack</th><th />
                  </tr>
                </thead>
                <tbody>
                  {people.map((p: any) => {
                    const cell = cellFor(p.id);
                    const byType = new Map(cell.statuses.map((s) => [s.type, s]));
                    return (
                      <tr key={p.id} data-campaign-row={p.id} data-pack-ready={cell.ready ? 'true' : 'false'}>
                        <td><b className="font-medium">{p.reference_code}</b><div className="text-ink3 text-[12px]">{p.full_name}</div></td>
                        <td className="text-[13px]">{p.trade ?? '—'}</td>
                        <td className="text-[13px]">{p.availability_from ? day(p.availability_from) : 'now'}</td>
                        {required.map((d) => {
                          const s = byType.get(d);
                          if (!s) return <td key={d} className="text-[13px] text-ink3">—</td>;
                          return (
                            // The reason is on the cell itself: a recruiter hovering a blank "verified"
                            // column should read why there is nothing there, not guess at a failure.
                            <td key={d} className={`text-[13px] ${STATE_TONE[s.state]}`} data-doc-type={d} data-doc-state={s.state} title={s.why}>
                              {stateWord(s)}
                              {s.state === 'expired' && s.expiresOn && <div className="text-[11px] text-ink3">{day(s.expiresOn)}</div>}
                              {s.state === 'verified' && s.expiresOn && <div className="text-[11px] text-ink3">to {day(s.expiresOn)}</div>}
                              {s.state === 'received' && !s.verifiable && <div className="text-[11px] text-ink3">no register</div>}
                            </td>
                          );
                        })}
                        <td className="text-[13px]">
                          {cell.ready
                            ? <span className="text-ok">ready</span>
                            : <span className="text-ink2" title={cell.blockers.join('; ')}>{cell.blockers.length} to clear</span>}
                        </td>
                        <td className="text-right">
                          <button className="btn text-[12px]" disabled={!!busy} onClick={() => call({ action: 'remove', campaign_id: c.id, candidate_id: p.id }, `rm-${p.id}`)}>Remove</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
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
              ) : (
                <div className="flex gap-2 items-center flex-wrap">
                  <button className="btn text-[12px]" onClick={() => setAdding(c.id)}>Add a candidate</button>
                  {/* Only the people this campaign's own requirements have cleared. It prepares the
                      packs and records who prepared them; nothing is emailed here, or anywhere but
                      /api/outreach, by a recruiter, to an address attached to a contact. */}
                  {readyCount > 0 && (
                    <button
                      className="btn btn-primary text-[12px]"
                      data-send-packs={readyCount}
                      disabled={busy === `pack-${c.id}`}
                      onClick={() => sendPacks(c, people.filter((p: any) => cellFor(p.id).ready).map((p: any) => p.id))}
                    >
                      {busy === `pack-${c.id}` ? 'Preparing…' : `Send ${readyCount} pack${readyCount === 1 ? '' : 's'}${c.companies?.name ? ` to ${c.companies.name}` : ''}`}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  </>);
}
