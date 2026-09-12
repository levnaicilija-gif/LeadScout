'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmployerTypeOverride } from './EmployerTypeOverride';
import { CountryPicker } from './CountryPicker';
import { ScoredCandidate } from './ScoredCandidate';
export function LeadDrawer({ lead }: { lead: any }) {
  const r = useRouter(); const [tool, setTool] = useState<'jd' | 'pool' | 'xray' | 'q'>('jd');
  const [out, setOut] = useState<any>({}); const [busy, setBusy] = useState(''); const [draft, setDraft] = useState<any>(null);
  const [xrayCountries, setXrayCountries] = useState<string[]>([]);
  const [xrayLocal, setXrayLocal] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ action: string; message: string; detail?: string } | null>(null);

  /**
   * Every drawer action, bounded and always answered.
   *
   * This used to be a bare fetch with no try/catch: a 500 whose body was not JSON, or a request
   * that never came back, threw before setBusy('') and left the button reading "Writing…" for
   * as long as the drawer stayed open. Nothing told the recruiter anything had gone wrong.
   */
  const call = async (action: string, extra: any = {}) => {
    setBusy(action); setFailed(null);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const res = await fetch('/api/lead', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal,
        body: JSON.stringify({ lead_id: lead.id, action, ...extra }),
      });
      const body = await res.text();
      let j: any = null;
      try { j = body ? JSON.parse(body) : null; } catch { /* an error page, not JSON */ }
      if (!res.ok || !j) {
        setFailed({ action, message: j?.error ?? plainly(res.status), detail: j ? undefined : body.slice(0, 500) });
        return {};
      }
      return j;
    } catch (e: any) {
      setFailed(e?.name === 'AbortError'
        ? { action, message: 'This took longer than 60 seconds and was stopped. Try again — it usually works on a second run.' }
        : { action, message: 'Could not reach the server. Check the connection and try again.', detail: String(e?.message ?? e) });
      return {};
    } finally { clearTimeout(timer); setBusy(''); }
  };

  const Failure = ({ action }: { action: string }) => failed?.action === action ? (
    <div className="mt-2 text-[13px] text-bad">
      {failed.message}
      {failed.detail && <details className="inline"> <summary className="cursor-pointer inline text-ink3">detail</summary><pre className="whitespace-pre-wrap mt-1 text-[12px] text-ink2">{failed.detail}</pre></details>}
    </div>
  ) : null;
  const c = lead.contacts?.[0];
  return (<aside className="fixed top-0 right-0 h-screen w-full sm:w-[500px] max-w-full bg-panel border-l border-line shadow-[-16px_0_48px_rgba(14,26,43,.12)] overflow-auto p-5 sm:p-6 pb-12 z-20">
    <a href="?" className="absolute top-3 right-3 text-ink3 text-lg" aria-label="Close">×</a>
    <h2 className="text-[18px] font-semibold">{lead.companies?.name}</h2>
    <div className="text-ink3 text-[13px] mb-4">{lead.kind === 'won_work' ? `Won: ${lead.project_name}` : `Hiring: ${lead.job_posts?.[0]?.role}`} · {lead.project_location}</div>

    <div className="text-[12px] text-ink3 mb-2">Source</div>
    <div className="flex items-center gap-2 text-[13px] mb-4"><span className={`st ${lead.source_fetch_status === 'live' ? 'st-ok' : 'st-bad'}`}>{lead.source_fetch_status}</span><a className="text-accent" href={lead.source_url} target="_blank" rel="noopener">Open source</a>{lead.confirmed_at ? <span className="text-ok">✓ confirmed</span> : <button className="btn" onClick={async () => { await call('confirm'); r.refresh(); }}>Confirm I checked it</button>}</div>

    <div className="text-[12px] text-ink3 mt-4 mb-2">What this company is</div>
    {lead.company_id && <EmployerTypeOverride companyId={lead.company_id} detected={lead.companies?.employer_type} override={lead.companies?.employer_type_override} setAt={lead.companies?.employer_type_set_at} />}

    <div className="text-[12px] text-ink3 mt-4 mb-2">Decision-maker</div>
    {c ? <div className="border border-line rounded p-3.5 text-[13px]"><b className="block font-semibold">{c.name}</b><div className="text-ink2">{c.title}</div>
      <div className="mt-2 grid gap-1">{c.phone && <span>{c.phone} <em className="not-italic text-ink3 text-[12px]">found · <a href={c.phone_source_url} target="_blank" className="underline">source</a></em></span>}{c.email ? <span>{c.email} <em className={`not-italic text-[12px] ${c.email_status === 'found' ? 'text-ok' : 'text-warn'}`}>{c.email_status}</em></span> : <span className="text-ink3">email unknown — use company address</span>}</div>
      <div className="mt-2 flex gap-2"><a className="btn" href={c.linkedin_search_url} target="_blank" rel="noopener">Find on LinkedIn</a><a className="btn" href={c.google_search_url} target="_blank" rel="noopener">Search name + company</a></div>
      {c.quote && <div className="mt-3 border-l-[3px] border-accent bg-accentsoft px-3 py-2 rounded-r">“{c.quote}”</div>}</div>
      : <div className="text-ink3 text-[13px]">No named person quoted. {lead.lead_people?.length ? 'People at this company from the attendee list:' : ''}</div>}
    {!!lead.lead_people?.length && <div className="border border-line rounded mt-2 text-[13px]">{lead.lead_people.map((lp: any, i: number) => <div key={i} className="px-3 py-2 border-b border-line2 last:border-0"><b className="font-medium">{lp.people.name}</b><div className="text-ink3 text-[12px]">{lp.people.title} · {lp.people.source} · title not verified</div></div>)}</div>}

    <div className="text-[12px] text-ink3 mt-5 mb-2">Work this need</div>
    <div className="grid gap-1.5">{([['jd', '1 · Need as a job description'], ['pool', '2 · Score the pool'], ['xray', '3 · Find candidates on LinkedIn'], ['q', '4 · Screening questions']] as const).map(([k, l]) => <button key={k} onClick={() => setTool(k)} className={`text-left border rounded px-3 py-2 ${tool === k ? 'border-accent bg-accentsoft' : 'border-line'}`}>{l}</button>)}</div>
    <div className="mt-3 text-[13px]">
      {tool === 'jd' && <><button className="btn btn-primary" disabled={!!busy} onClick={async () => setOut({ ...out, jd: await call('jd') })}>{busy === 'jd' ? 'Writing…' : lead.job_description ? 'Rewrite JD' : 'Write JD'}</button><Failure action="jd" />{(out.jd?.job_description ?? lead.job_description) && <div data-result="jd" className="mt-2 border border-line rounded bg-[#FAFBFC] p-3 whitespace-pre-wrap">{out.jd?.job_description ?? lead.job_description}{out.jd?.assumptions?.length > 0 && <div className="mt-2 text-warn text-[12px]">Assumed (confirm on the call): {out.jd.assumptions.join(' · ')}</div>}</div>}</>}
      {tool === 'pool' && <><button className="btn btn-primary" disabled={!!busy} onClick={async () => setOut({ ...out, pool: await call('score_pool') })}>{busy === 'score_pool' ? 'Scoring…' : 'Score the pool'}</button><Failure action="score_pool" />{out.pool?.error && <div className="text-bad mt-2">{out.pool.error}</div>}{out.pool?.ranked?.length === 0 && <div className="text-ink3 mt-2">No candidates in the pool yet — add CVs in Verify and they will be scored against this job.</div>}{out.pool?.ranked?.length > 0 && <div className="border border-line rounded mt-2">{out.pool.ranked.map((x: any) => <ScoredCandidate key={x.id} x={x} jd={lead.job_description} jobCountry={lead.country} />)}</div>}</>}
      {tool === 'xray' && <><button className="btn btn-primary" disabled={!!busy} onClick={async () => { const j = await call('xray', xrayCountries.length ? { countries: xrayCountries } : {}); if (j.countries) setXrayCountries(j.countries); setXrayLocal(j.localUrl ?? null); if (j.url) window.open(j.url, '_blank'); }}>{busy === 'xray' ? 'Building…' : 'Open LinkedIn search'}</button><Failure action="xray" /><CountryPicker value={xrayCountries} onChange={setXrayCountries} jobCountry={lead.country} />{xrayLocal && <a className="btn mt-2 inline-block" href={xrayLocal} target="_blank" rel="noopener">Also search in the local trade words</a>}<div className="text-ink3 text-[12px] mt-2">Built from the JD, English only, plus a second variant in the job's own language area. Drop chosen CVs into Verify → they score against this lead.</div></>}
      {tool === 'q' && <><button className="btn btn-primary" disabled={!!busy} onClick={async () => setOut({ ...out, q: await call('questions') })}>{busy === 'questions' ? 'Writing…' : 'Get questions'}</button><Failure action="questions" />{out.q?.questions?.length === 0 && <div className="text-ink3 mt-2">No questions came back. Try again.</div>}{out.q?.rightToWorkRule && <div className="text-[12px] text-ink3 mt-2">{out.q.rightToWorkRule}</div>}{out.q?.questions?.length > 0 && <ol className="list-decimal pl-5 mt-2">{out.q.questions.map((q: any, i: number) => <li key={i} className="mb-2"><b className="font-medium block">{q.q}</b><small className="text-ink3">Good: {q.good_answer}</small></li>)}</ol>}</>}
    </div>

    <div className="text-[12px] text-ink3 mt-5 mb-2">Outreach</div>
    {!draft ? <><button className="btn btn-primary" disabled={!!busy || !lead.confirmed_at} title={lead.confirmed_at ? '' : 'Confirm the source first'} onClick={async () => { const j = await call('draft'); if (j.subject) setDraft(j); }}>{busy === 'draft' ? 'Drafting…' : 'Draft email + LinkedIn message'}</button><Failure action="draft" /></>
      : <div className="border border-line rounded bg-[#FAFBFC] p-3 text-[13px]"><input className="w-full border border-line rounded px-2 py-1 mb-2 font-medium" defaultValue={draft.subject} id="subj" /><textarea className="w-full border border-line rounded px-2 py-1 h-40" defaultValue={draft.email} id="body" /><div className="text-[12px] text-ink3 mt-1">{draft.reasoning}</div>{draft.recipient?.name && <div className="text-[12px] mt-1"><b className="font-medium">To {draft.recipient.name}</b>{draft.recipient.title ? ` · ${draft.recipient.title}` : ''}{draft.redirected && <span className="text-warn"> · moved off the quoted executive</span>}</div>}{draft.unsupported?.length > 0 && <div className="text-bad text-[12px] mt-2">Could not be traced to your data — check or remove before sending: {draft.unsupported.map((u: any) => `"${u.phrase}"`).join(', ')}</div>}
        <div className="flex gap-2 mt-3 flex-wrap"><input className="border border-line rounded px-2 py-1 flex-1" placeholder="to: contact or company email" id="to" defaultValue={c?.email ?? ''} /><button className="btn btn-primary" onClick={async () => { const res = await fetch('/api/outreach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outreach_id: draft.outreach_id, to: (document.getElementById('to') as HTMLInputElement).value, subject: (document.getElementById('subj') as HTMLInputElement).value, body: (document.getElementById('body') as HTMLTextAreaElement).value }) }); const j = await res.json(); alert(j.ok ? 'Sent' : j.error); if (j.ok) r.refresh(); }}>Send</button><button className="btn" onClick={() => navigator.clipboard.writeText(draft.linkedin)}>Copy LinkedIn message</button></div></div>}
    <div className="flex gap-2 mt-4"><button className="btn" onClick={async () => { await call('status', { status: 'pursue' }); r.refresh(); }}>Mark pursued</button><button className="btn" onClick={async () => { await call('status', { status: 'not_for_us' }); r.push('/app/radar'); }}>Not for us</button></div>
  </aside>);
}

/** HTTP status in words a recruiter can act on. */
function plainly(status: number) {
  if (status === 401) return 'Your session has expired — sign in again.';
  if (status === 404) return 'This lead could not be loaded. Refresh the page.';
  if (status === 504 || status === 408) return 'The server took too long and gave up. Try again.';
  if (status >= 500) return 'Something went wrong on the server. Try again; if it keeps failing, the detail below is what to send on.';
  return `The request was refused (HTTP ${status}).`;
}
