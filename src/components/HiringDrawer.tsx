'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmployerTypeOverride } from './EmployerTypeOverride';
import { CountryPicker } from './CountryPicker';
import { ScoredCandidate } from './ScoredCandidate';

/**
 * The drawer on a Hiring now row.
 *
 * Same shape as the lead drawer where it fits, and deliberately different where it does not:
 * there is no lead behind this, so there is no quote to open with and no article to confirm.
 * What there is instead is a stack of adverts, and every tool here reads from them.
 *
 * Nothing invents a contact. The contact block shows what was read off a page, the company's
 * front door when it is known, people already on file whose title means they book trades — and,
 * when all of that is empty, searches for the recruiter to run, which are never dressed up as
 * people we found.
 */
type Group = {
  companyId: string;
  company: string;
  employerType: string | null;
  employerOverride?: string | null;
  employerSetAt?: string | null;
  country: string | null;
  postings: any[];
  trades: string[];
  certs: string[];
  pressure: 'high' | 'medium' | 'low';
  pressureWhy: string;
  confirmedAt?: string | null;
  status?: string | null;
  readyByTrade: { trade: string; n: number }[];
};

const day = (s?: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null);

export function HiringDrawer({ g }: { g: Group }) {
  const r = useRouter();
  const [tool, setTool] = useState<'jd' | 'pool' | 'xray' | 'q'>('jd');
  const [out, setOut] = useState<any>({});
  const [busy, setBusy] = useState('');
  const [failed, setFailed] = useState<{ action: string; message: string; detail?: string } | null>(null);
  const [sheet, setSheet] = useState<any>(null);
  const [draft, setDraft] = useState<any>(null);
  const [countries, setCountries] = useState<string[]>([]);
  const [sendState, setSendState] = useState<{ ok?: boolean; error?: string } | null>(null);

  /** Every action bounded and always answered — a button must never sit on "Writing…". */
  const call = async (action: string, extra: any = {}) => {
    setBusy(action); setFailed(null);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90_000);
    try {
      const res = await fetch('/api/hiring', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal,
        body: JSON.stringify({ company_id: g.companyId, action, ...extra }),
      });
      const text = await res.text();
      let j: any = null;
      try { j = text ? JSON.parse(text) : null; } catch { /* an error page, not JSON */ }
      if (!res.ok || !j) {
        setFailed({ action, message: j?.error ?? `The server answered ${res.status}.`, detail: j ? undefined : text.slice(0, 400) });
        return {};
      }
      return j;
    } catch (e: any) {
      setFailed(e?.name === 'AbortError'
        ? { action, message: 'This took longer than 90 seconds and was stopped. Try again — it usually works on a second run.' }
        : { action, message: 'Could not reach the server.', detail: String(e?.message ?? e) });
      return {};
    } finally { clearTimeout(timer); setBusy(''); }
  };

  // The contact sheet is the first thing a recruiter looks at, so it loads with the drawer.
  useEffect(() => { call('sheet').then((j) => j?.sheet && setSheet(j)); /* eslint-disable-next-line */ }, [g.companyId]);

  const Failure = ({ action }: { action: string }) => failed?.action === action ? (
    <div className="mt-2 text-[13px] text-bad">
      {failed.message}
      {failed.detail && <details className="inline"> <summary className="cursor-pointer inline text-ink3">detail</summary><pre className="whitespace-pre-wrap mt-1 text-[12px] text-ink2">{failed.detail}</pre></details>}
    </div>
  ) : null;

  const Label = ({ children }: { children: React.ReactNode }) => <div className="text-[12px] text-ink3 mt-4 mb-2">{children}</div>;

  const send = async () => {
    if (!draft?.outreachId || !draft?.to) return;
    setBusy('send'); setSendState(null);
    const res = await fetch('/api/outreach', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outreach_id: draft.outreachId, to: draft.to, subject: draft.subject, body: draft.email }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy('');
    setSendState(res.ok ? { ok: true } : { error: j?.error ?? `send failed (HTTP ${res.status})` });
  };

  const mailto = draft?.to
    ? `mailto:${draft.to}?subject=${encodeURIComponent(draft.subject ?? '')}&body=${encodeURIComponent(draft.email ?? '')}`
    : null;

  return (
    <aside className="fixed top-0 right-0 h-screen w-full sm:w-[540px] max-w-full bg-panel border-l border-line shadow-[-16px_0_48px_rgba(14,26,43,.12)] overflow-auto p-5 sm:p-6 pb-12 z-20">
      <a href="?tab=hiring" className="absolute top-3 right-3 text-ink3 text-lg" aria-label="Close">×</a>

      <h2 className="font-display text-[19px] font-bold pr-6">{g.company}</h2>
      <div className="text-ink3 text-[13px] mb-1">
        {[g.country, `${g.postings.length} advert${g.postings.length === 1 ? '' : 's'} open`].filter(Boolean).join(' · ')}
      </div>
      <div className="flex gap-1.5 flex-wrap mb-3">
        <span className={`badge ${g.pressure === 'high' ? 'badge-bad' : g.pressure === 'medium' ? 'badge-warn' : ''}`} title={g.pressureWhy}>
          {g.pressure} pressure
        </span>
        {g.status === 'pursued' && <span className="badge badge-info">pursued</span>}
        {g.confirmedAt && <span className="badge badge-ok">✓ board checked</span>}
      </div>

      {/* ---------------------------------------------------- who to contact */}
      <Label>Who to contact</Label>
      {!sheet && <div className="text-ink3 text-[13px]">Reading what we hold…</div>}
      {sheet?.sheet && (
        <div className="grid gap-2">
          {sheet.sheet.contacts.map((c: any, i: number) => (
            <div key={i} className={`border rounded-card p-3 text-[13px] ${i === 0 ? 'border-accent bg-accentsoft' : 'border-line'}`}>
              {i === 0 && <div className="text-[11px] font-semibold text-accent uppercase tracking-wide mb-1">Try this one first</div>}
              <b className="font-semibold">{c.name}</b>
              {c.title && <span className="text-ink2"> · {c.title}</span>}
              <span className={`badge ml-2 ${c.where === 'posting' ? 'badge-ok' : ''}`}>{c.where}</span>
              <div className="mt-1 grid gap-0.5">
                {c.email && <span>{c.email} <em className={`not-italic text-[12px] ${c.emailStatus === 'found' ? 'text-ok' : 'text-warn'}`}>{c.emailStatus}</em></span>}
                {c.phone && <span>{c.phone}</span>}
                {!c.email && !c.phone && <span className="text-ink3 text-[12px]">no address or number printed — use the searches below</span>}
              </div>
              <div className="text-ink3 text-[12px] mt-1">
                read from <a href={c.sourceUrl} target="_blank" rel="noopener" className="text-accent">{(() => { try { return new URL(c.sourceUrl).hostname.replace(/^www\./, ''); } catch { return c.sourceUrl; } })()}</a>
                {c.readAt ? ` · ${day(c.readAt)}` : ''}
              </div>
              {(c.linkedinSearchUrl || c.googleSearchUrl) && (
                <div className="flex gap-2 mt-2">
                  {c.linkedinSearchUrl && <a className="btn text-[12px]" href={c.linkedinSearchUrl} target="_blank" rel="noopener">Find on LinkedIn</a>}
                  {c.googleSearchUrl && <a className="btn text-[12px]" href={c.googleSearchUrl} target="_blank" rel="noopener">Search name + company</a>}
                </div>
              )}
            </div>
          ))}

          {/* The front door is always shown when it is known. */}
          {(sheet.sheet.switchboard || sheet.sheet.generalEmail) && (
            <div className="border border-line rounded-card p-3 text-[13px]">
              <b className="font-semibold">The company itself</b>
              {sheet.sheet.switchboard && <div className="mt-1">{sheet.sheet.switchboard.value} <a className="text-accent text-[12px]" href={sheet.sheet.switchboard.sourceUrl} target="_blank" rel="noopener">source</a></div>}
              {sheet.sheet.generalEmail && <div>{sheet.sheet.generalEmail.value} <a className="text-accent text-[12px]" href={sheet.sheet.generalEmail.sourceUrl} target="_blank" rel="noopener">source</a></div>}
            </div>
          )}

          {sheet.sheet.nobodyFound && (
            <div className="border border-line rounded-card p-3 text-[13px] bg-[#FAFBFC]">
              <b className="font-semibold">Nobody found yet — searches to run</b>
              <div className="text-ink3 text-[12px] mt-0.5 mb-2">These are searches, not contacts. Nothing here has been read off a page.</div>
              <div className="grid gap-1.5">
                {sheet.sheet.searches.map((s: any, i: number) => (
                  <a key={i} href={s.url} target="_blank" rel="noopener" className="border border-line rounded px-3 py-2 bg-panel hover:border-accent">
                    <b className="font-medium">{s.label.split(' — ')[0]}</b><span className="text-ink3"> — {s.label.split(' — ')[1]}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
          {sheet.rule && <div className="text-[12px] text-ink2 border border-line rounded px-3 py-2">Right to work: {sheet.rule}</div>}
        </div>
      )}

      {/* --------------------------------------------------------- postings */}
      <Label>What they are hiring for</Label>
      <div className="border border-line rounded-card divide-y divide-line2">
        {g.postings.map((p: any) => (
          <div key={p.id} className="px-3 py-2.5 text-[13px]">
            <b className="font-medium">{p.role ?? p.title ?? 'Trade role'}{p.headcount > 1 ? ` ×${p.headcount}` : ''}</b>
            <div className="text-ink3 text-[12px]">
              {[p.location, p.rotation, p.contract_type, p.posted_at && `posted ${day(p.posted_at)}`].filter(Boolean).join(' · ') || 'no detail printed'}
            </div>
            {p.certs_required?.length > 0 && <div className="text-[12px] mt-0.5">Certificates asked for: {p.certs_required.join(', ')}</div>}
            <a href={p.source_url} target="_blank" rel="noopener" className="text-accent text-[12px]">Open board</a>
          </div>
        ))}
      </div>

      {/* --------------------------------------------- company and confirming */}
      <Label>What this company is</Label>
      <EmployerTypeOverride companyId={g.companyId} detected={g.employerType} override={g.employerOverride} setAt={g.employerSetAt} />

      <Label>The source</Label>
      <div className="flex items-center gap-2 text-[13px] flex-wrap">
        <a className="text-accent" href={g.postings[0]?.source_url} target="_blank" rel="noopener">Open the board</a>
        {g.confirmedAt
          ? <span className="text-ok">✓ checked {day(g.confirmedAt)}</span>
          : <button className="btn" disabled={!!busy} onClick={async () => { const j = await call('confirm'); if (j?.ok) r.refresh(); }}>
              {busy === 'confirm' ? 'Recording…' : 'Confirm I looked at it'}
            </button>}
      </div>
      <Failure action="confirm" />

      {/* ------------------------------------------------- ready to attach */}
      <Label>Ready to attach</Label>
      {g.readyByTrade.length === 0
        ? <div className="text-ink3 text-[13px]">No verified candidates in the trades they are asking for.</div>
        : <div className="flex gap-1.5 flex-wrap">
            {g.readyByTrade.map((t) => <span key={t.trade} className="badge badge-ok">{t.n} {t.trade}</span>)}
          </div>}

      {/* ------------------------------------------------------------ tools */}
      <Label>Tools</Label>
      <div className="grid gap-1.5">
        {([['jd', '1 · Need as a job description'], ['pool', '2 · Score the pool'], ['xray', '3 · Find candidates on LinkedIn'], ['q', '4 · Screening questions']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTool(k)} className={`text-left border rounded px-3 py-2 ${tool === k ? 'border-accent bg-accentsoft' : 'border-line'}`}>{l}</button>
        ))}
      </div>

      <div className="mt-3">
        {tool === 'jd' && (<>
          <button className="btn btn-primary" disabled={!!busy} onClick={async () => { const j = await call('jd'); if (j?.job_description) setOut({ ...out, jd: j }); }}>
            {busy === 'jd' ? 'Writing…' : 'Write it from the adverts'}
          </button>
          <Failure action="jd" />
          {out.jd && <>
            <pre data-result="jd" className="whitespace-pre-wrap text-[13px] mt-2 border border-line rounded-card p-3 bg-[#FAFBFC]">{out.jd.job_description}</pre>
            {out.jd.assumptions?.length > 0 && <div className="text-[12px] text-warn mt-1">Assumed, confirm on the call: {out.jd.assumptions.join(' · ')}</div>}
          </>}
        </>)}

        {tool === 'pool' && (<>
          <button className="btn btn-primary" disabled={!!busy || !out.jd} onClick={async () => { const j = await call('score_pool', { job_description: out.jd?.job_description }); if (j?.ranked) setOut({ ...out, ranked: j.ranked }); }}>
            {busy === 'score_pool' ? 'Scoring…' : 'Score the pool'}
          </button>
          {!out.jd && <div className="text-ink3 text-[12px] mt-1">Write the job description first — the score is against it.</div>}
          <Failure action="score_pool" />
          {out.ranked?.map((c: any) => <ScoredCandidate key={c.id} x={c} jd={out.jd?.job_description} jobCountry={g.country} />)}
          {out.ranked?.length === 0 && <div className="text-ink3 text-[13px] mt-2">Nobody in the pool scored against this.</div>}
        </>)}

        {tool === 'xray' && (<>
          <CountryPicker value={countries} onChange={setCountries} />
          <button className="btn btn-primary mt-2" disabled={!!busy} onClick={async () => { const j = await call('xray', { countries }); if (j?.url) setOut({ ...out, xray: j }); }}>
            {busy === 'xray' ? 'Building…' : 'Build the search'}
          </button>
          <Failure action="xray" />
          {out.xray && <div className="mt-2 text-[13px] grid gap-1">
            <div className="text-ink3 text-[12px]">Countries follow the job ({out.xray.jobCountry ?? 'country not stated'}): {out.xray.countries.join(', ')}</div>
            <a className="text-accent" href={out.xray.url} target="_blank" rel="noopener">Open the English search</a>
            {out.xray.localUrl && <a className="text-accent" href={out.xray.localUrl} target="_blank" rel="noopener">Open the local-language variant</a>}
          </div>}
        </>)}

        {tool === 'q' && (<>
          <button className="btn btn-primary" disabled={!!busy || !out.jd} onClick={async () => { const j = await call('questions', { job_description: out.jd?.job_description }); if (j?.questions) setOut({ ...out, questions: j.questions }); }}>
            {busy === 'questions' ? 'Writing…' : 'Write the questions'}
          </button>
          {!out.jd && <div className="text-ink3 text-[12px] mt-1">Write the job description first — the questions come from it.</div>}
          <Failure action="questions" />
          {out.questions?.map((q: any, i: number) => (
            <div key={i} className="text-[13px] mt-2 border-t border-line2 pt-2">
              <b className="font-medium">{i + 1}. {q.q}</b>
              <div className="text-ink3 text-[12px]">Good answer: {q.good_answer}</div>
            </div>
          ))}
        </>)}
      </div>

      {/* --------------------------------------------------------- approach */}
      <Label>The approach</Label>
      <button className="btn btn-primary" disabled={!!busy} onClick={async () => { const j = await call('draft'); if (j?.email) setDraft(j); }}>
        {busy === 'draft' ? 'Drafting…' : 'Draft the email and the LinkedIn message'}
      </button>
      <Failure action="draft" />

      {draft && (
        <div className="mt-2 border border-line rounded-card p-3 text-[13px]">
          <div className="text-ink3 text-[12px]">
            To: {draft.to ?? <span className="text-warn">no address on file — use the searches above</span>}
            {draft.to && <span className={`badge ml-2 ${draft.toStatus === 'found' ? 'badge-ok' : 'badge-warn'}`}>{draft.toStatus}</span>}
          </div>
          <b className="block font-semibold mt-1">{draft.subject}</b>
          <pre className="whitespace-pre-wrap mt-1">{draft.email}</pre>

          {draft.reasoning && <div className="text-ink2 text-[12px] mt-2 border-t border-line2 pt-2"><b className="font-medium">Why it is written this way:</b> {draft.reasoning}</div>}
          {draft.unsupported?.length > 0 && (
            <div className="text-warn text-[12px] mt-2">
              These claims are not backed by the pool and must be removed before sending: {draft.unsupported.map((u: any) => `"${u.phrase}"`).join(', ')}
            </div>
          )}

          <div className="flex gap-2 mt-3 flex-wrap items-center">
            <button
              className="btn btn-primary disabled:opacity-50"
              disabled={!draft.send?.canSend || !draft.to || !!busy || draft.unsupported?.length > 0}
              onClick={send}
              title={draft.send?.canSend ? 'Send through Resend' : draft.send?.reason}
            >
              {busy === 'send' ? 'Sending…' : 'Send'}
            </button>
            {mailto && <a className="btn" href={mailto}>Open in your mail client</a>}
            <button className="btn" onClick={() => navigator.clipboard.writeText(draft.linkedin ?? '')}>Copy LinkedIn message</button>
          </div>

          {/* The button stays visible and says what is missing. Hidden would read as "this
              feature does not exist"; disabled with a reason says who has to fix what. */}
          {!draft.send?.canSend && (
            <div className="text-[12px] text-warn mt-1.5">
              Sending is off: {draft.send?.reason}. The draft is saved — copy it or open it in your mail client.
            </div>
          )}
          {draft.unsupported?.length > 0 && <div className="text-[12px] text-ink3 mt-1">Send is held until the unsupported claims are gone.</div>}
          {sendState?.ok && <div className="text-ok text-[13px] mt-2">Sent to {draft.to}.</div>}
          {sendState?.error && <div className="text-bad text-[13px] mt-2">{sendState.error}</div>}
        </div>
      )}

      {/* ---------------------------------------------------- row decisions */}
      <Label>This row</Label>
      <div className="flex gap-2 flex-wrap">
        <button className="btn" disabled={!!busy} onClick={async () => { const j = await call('status', { status: 'pursued' }); if (j?.ok) r.refresh(); }}>
          {g.status === 'pursued' ? 'Pursuing — appears in Today' : 'Pursue'}
        </button>
        <button className="btn" disabled={!!busy} onClick={async () => { const j = await call('status', { status: 'not_for_us' }); if (j?.ok) { r.push('?tab=hiring'); r.refresh(); } }}>
          Not for us
        </button>
      </div>
      <Failure action="status" />
    </aside>
  );
}
