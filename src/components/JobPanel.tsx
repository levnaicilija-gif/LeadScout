'use client';
import { useEffect, useState } from 'react';

/** country is the country the WORK is in — right to work is keyed on it, not on the candidate. */
export type JobChoice = { id: string | null; label: string; jd: string; country?: string | null };

/**
 * "Match against a job" — the right-hand panel.
 *
 * A recruiter almost always means a lead that already exists, so the open leads and job posts
 * come first and pasted text is the last option, not the only one. The chosen job is applied
 * to every CV in the batch.
 */
export function JobPanel({ value, onChange }: { value: JobChoice | null; onChange: (v: JobChoice | null) => void }) {
  const [options, setOptions] = useState<{ id: string; label: string; jd: string; kind: string; fit: number; country?: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');

  useEffect(() => {
    fetch('/api/leads/open')
      .then((r) => r.json())
      .then((j) => setOptions(j.options ?? []))
      .catch(() => setOptions([]))
      .finally(() => setLoading(false));
  }, []);

  const pick = (id: string) => {
    if (id === '') { onChange(null); setPasting(false); return; }
    if (id === '__paste') { setPasting(true); onChange(text.trim() ? { id: null, label: 'Pasted job description', jd: text } : null); return; }
    const o = options.find((x) => x.id === id);
    setPasting(false);
    onChange(o ? { id: o.id, label: o.label, jd: o.jd, country: o.country ?? null } : null);
  };

  return (
    <div className="bg-panel border border-line rounded-card">
      <div className="px-4 py-3 border-b border-line flex justify-between">
        <b className="font-semibold">Match against a job</b><span className="text-ink3 text-[12px]">optional</span>
      </div>
      <div className="p-3">
        <select
          className="w-full border border-line rounded px-2.5 py-2 bg-panel text-[13px]"
          value={pasting ? '__paste' : value?.id ?? ''}
          onChange={(e) => pick(e.target.value)}
          disabled={loading}
        >
          <option value="">{loading ? 'Loading open leads…' : 'Choose an open lead or job post…'}</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          <option value="__paste">or paste a job description</option>
        </select>

        {pasting && (
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); onChange(e.target.value.trim() ? { id: null, label: 'Pasted job description', jd: e.target.value } : null); }}
            rows={6}
            placeholder="Paste a job description or posting…"
            className="w-full border border-line rounded px-2.5 py-2 mt-2 text-[13px]"
          />
        )}

        {!loading && options.length === 0 && !pasting && (
          <div className="text-ink3 text-[12px] mt-2">No open leads yet — paste a job description instead.</div>
        )}

        <div className="text-ink3 text-[12px] mt-2">
          Every CV in the batch is scored against this job. You get fits, missing, blockers and a recommendation.
        </div>
      </div>
    </div>
  );
}

/** Attaches the chosen candidates to the lead, with the guardrail warnings surfaced. */
export function SendToLead({ leadId, leadLabel, candidateIds }: { leadId: string; leadLabel: string; candidateIds: string[] }) {
  const [state, setState] = useState<{ busy?: boolean; done?: string; warnings?: string[]; err?: string }>({});

  const send = async (acknowledge = false) => {
    setState({ busy: true });
    try {
      const r = await fetch('/api/leads/send-pack', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lead_id: leadId, candidate_ids: candidateIds, acknowledge_warnings: acknowledge }),
      });
      const j = await r.json();
      if (j.needsAcknowledgement) { setState({ warnings: j.warnings }); return; }
      if (!r.ok) { setState({ err: j.error ?? `HTTP ${r.status}` }); return; }
      setState({ done: `Attached ${j.attached.join(', ')} to ${j.lead.company ?? leadLabel}` });
    } catch (e: any) { setState({ err: e?.message ?? String(e) }); }
  };

  if (state.done) return <span className="text-ok text-[13px] self-center">{state.done}</span>;

  return (<>
    <button className="btn btn-primary" disabled={state.busy || candidateIds.length === 0} onClick={() => send(false)}>
      {state.busy ? '…' : `Send to this lead`}
    </button>
    {state.warnings && (
      <div className="w-full mt-2 border border-warn rounded p-3 text-[13px] bg-warnsoft">
        <b className="text-warn">Check these before sending</b>
        <ul className="list-disc pl-5 mt-1">{state.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        <button className="btn mt-2" onClick={() => send(true)}>Send anyway — I have checked</button>
      </div>
    )}
    {state.err && <span className="text-bad text-[12px] self-center">{state.err}</span>}
  </>);
}
