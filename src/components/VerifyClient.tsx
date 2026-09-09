'use client';
import { useState } from 'react';
import { PreviewPdf } from './PreviewPdf';

/** Nothing may spin forever: every call is bounded and every failure is shown. */
const STEP_TIMEOUT_MS = 90_000;

async function call(url: string, init: RequestInit, timeoutMs = STEP_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    const body = await r.text();
    let json: any = null;
    try { json = body ? JSON.parse(body) : null; } catch { /* an error page, not JSON */ }
    if (!r.ok) throw new Error(json?.error ?? `${url} failed (HTTP ${r.status})`);
    if (!json) throw new Error(`${url} returned something that is not JSON (HTTP ${r.status})`);
    return json;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`${url} took longer than ${Math.round(timeoutMs / 1000)}s and was stopped. Nothing was lost — the upload may still have saved.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function VerifyClient({ mode }: { mode: 'cert' | 'cv' }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [job, setJob] = useState('');
  const [res, setRes] = useState<any>(null);

  const run = async (files: FileList | File[]) => {
    setErr(''); setRes(null);
    try {
      if (mode === 'cert') {
        setBusy('Reading the certificate…');
        const fd = new FormData();
        fd.append('file', files[0]);
        const step1 = await call('/api/verify', { method: 'POST', body: fd });
        setRes({ cert: step1 });                       // show what was read straight away

        if (step1.next === 'lookup' || step1.next === 'issuer_email') {
          setBusy(step1.next === 'lookup' ? 'Checking the issuer’s register…' : 'Preparing the issuer email…');
          try {
            const step2 = await call('/api/verify/lookup', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ document_id: step1.document.id }),
            });
            setRes({ cert: { ...step1, ...step2 } });
          } catch (e: any) {
            // The extraction stands even when the register does not answer.
            setRes({ cert: { ...step1, lookupError: e.message } });
          }
        }
      } else {
        setBusy('Reading the CVs…');
        const fd = new FormData();
        for (const f of Array.from(files)) fd.append('files', f);
        const step1 = await call('/api/anonymize', { method: 'POST', body: fd });
        setRes({ cv: step1 });

        const out = [...(step1.results ?? [])];
        for (let i = 0; i < out.length; i++) {
          setBusy(`Preparing the client version (${i + 1} of ${out.length})…`);
          try {
            const enriched = await call('/api/anonymize/enrich', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ candidate_id: out[i].candidate.id, job: job || undefined }),
            });
            out[i] = { ...out[i], ...enriched };
          } catch (e: any) {
            out[i] = { ...out[i], enrichError: e.message };
          }
          setRes({ cv: { ...step1, results: [...out] } });
        }
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy('');                                     // always, however it ended
    }
  };

  const Drop = ({ label, sub }: { label: string; sub: string }) => (
    <label onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); run(e.dataTransfer.files); }} className={`block border-[1.5px] border-dashed rounded bg-panel p-11 text-center cursor-pointer ${over ? 'border-accent bg-accentsoft' : 'border-[#B3BDCA]'}`}>
      <b className="block text-[15px] font-semibold">{label}</b><span className="text-ink3 text-[13px]">{sub}</span>
      <input type="file" multiple={mode === 'cv'} accept=".pdf,.jpg,.jpeg,.png,.docx,.txt" className="hidden" disabled={!!busy} onChange={(e) => e.target.files && run(e.target.files)} />
      <div className="mt-3 text-[13px] text-accent">{busy || 'or click to choose'}</div>
    </label>);

  const KV = ({ rows }: { rows: [string, any][] }) => <div className="grid grid-cols-[130px_1fr] gap-y-1.5 text-[13px] mt-3">{rows.map(([k, v], i) => <><span key={'k' + i} className="text-ink3">{k}</span><span key={'v' + i}>{v ?? '—'}</span></>)}</div>;

  const v = res?.cert; const ver = v?.verification;
  return (<>
    {mode === 'cert' ? <Drop label="Drop a certificate here" sub="FROSIO, PCN, CSWIP, AMPP, IRATA, GWO, CISRS, welder ISO 9606, electrical · PDF or photo" />
      : <div className="grid grid-cols-2 gap-4"><Drop label="Drop CVs here" sub="Any language · PDF, DOCX, image or text · several at once" /><div className="bg-panel border border-line rounded"><div className="px-4 py-3 border-b border-line flex justify-between"><b className="font-semibold">Match against a job</b><span className="text-ink3 text-[12px]">optional</span></div><div className="p-3"><textarea value={job} onChange={(e) => setJob(e.target.value)} rows={6} placeholder="Paste a job description or posting…" className="w-full border border-line rounded px-2.5 py-2" /></div></div></div>}

    {err && <div className="mt-4 bg-panel border border-bad rounded p-4 text-[13px]"><b className="text-bad">That did not work.</b><div className="mt-1">{err}</div></div>}

    {v && <div className="bg-panel border border-line rounded p-4 mt-4 grid grid-cols-[1fr_auto] gap-4">
      <div><div className="text-[17px] font-semibold flex items-center gap-2"><span className={`w-2.5 h-2.5 rounded-full ${ver?.result === 'valid' ? 'bg-ok' : ver?.result === 'pending' || ver?.result === 'consistent_with_test_report' ? 'bg-warn' : v.verdict?.result === 'needs_retake' ? 'bg-warn' : ver ? 'bg-bad' : 'bg-accent'}`} />
        {ver?.result === 'valid' ? `Valid${ver.valid_until ? ` until ${ver.valid_until}` : ''}` : ver?.result === 'pending' ? ver.notes : ver?.result === 'consistent_with_test_report' ? 'Consistent with test report — issuer confirmation requested' : ver?.result === 'not_found' ? 'Not found on issuer site' : ver?.result === 'not_supported' ? 'No online register for this body — manual check' : ver?.result === 'invalid' ? 'Expired or invalid' : v.verdict?.result === 'needs_retake' ? `Retake needed: ${v.verdict.unreadable.join(', ')}` : v.extracted?.doc_type !== 'certificate' ? `Read as ${v.extracted?.doc_type} — saved` : busy ? 'Read — checking the register…' : 'Read'}</div>
        <div className="text-ink3 text-[12px]">{[v.extracted?.issuer, v.extracted?.level ?? v.extracted?.process, v.extracted?.number && `No. ${v.extracted.number}`].filter(Boolean).join(' · ')}</div>
        <KV rows={[['Holder', v.extracted?.holder], ['Checked where', ver?.checked_where ? <a className="text-accent" href={ver.checked_where} target="_blank">{ver.checked_where}</a> : '—'], ['Checked', ver?.checked_at ? new Date(ver.checked_at).toLocaleString() : '—'], ['Notes', ver?.notes ?? '—'], ['Warnings', v.warnings?.length ? <span className="text-warn">{v.warnings.join(' · ')}</span> : 'none']]} />
        {v.lookupError && <div className="mt-3 text-[13px] text-warn">The certificate was read and saved, but the register check failed: {v.lookupError}</div>}
        {v.issuerEmailDraft && <details className="mt-3 text-[13px]"><summary className="cursor-pointer text-accent">Issuer email — drafted, you send it</summary><pre className="whitespace-pre-wrap bg-[#FAFBFC] border border-line rounded p-3 mt-2">{v.issuerEmailDraft.subject}{'\n\n'}{v.issuerEmailDraft.body}</pre></details>}
      </div>
      {ver?.screenshot_path && <div className="w-[150px] h-[96px] border border-line rounded bg-line2 text-[10px] text-ink3 grid place-items-end p-1">screenshot saved</div>}
    </div>}

    {res?.cv && <div className="mt-4 grid gap-3">
      {(res.cv.failed ?? []).map((f: any, i: number) => <div key={'f' + i} className="bg-panel border border-bad rounded p-3 text-[13px]"><b className="text-bad">{f.file}</b> — {f.why}</div>)}
      {res.cv.results?.map((x: any, i: number) => <div key={i} className="bg-panel border border-line rounded p-4 grid grid-cols-[1fr_auto] gap-4"><div>
        <div className="text-[17px] font-semibold flex items-center gap-2"><span className={`w-2.5 h-2.5 rounded-full ${x.piiHits?.length ? 'bg-bad' : x.piiPassed ? 'bg-ok' : 'bg-accent'}`} />{x.piiHits?.length ? `Blocked: ${x.piiHits.join(', ')}` : x.piiPassed ? 'Anonymized CV ready' : 'CV read'}</div>
        <div className="text-ink3 text-[12px]">reference {x.candidate.reference_code}{x.file ? ` · ${x.file}` : ''}</div>
        <KV rows={[['Removed', x.removed.join(', ')], ['Kept', 'trade, certificates with status, projects by type and country, rotations, languages, availability'], ['Certs in CV', `${x.crossCheck?.claimed ?? 0} claimed · ${x.crossCheck?.verified ?? 0} verified on file`]]} />
        {x.bullets && <><div className="text-[12px] text-ink3 mt-3 mb-1">Three bullets for the client</div><ul className="list-disc pl-5 text-[13px]">{x.bullets.map((b: string, j: number) => <li key={j}>{b}</li>)}</ul></>}
        {x.score && <div className="mt-3 border border-line rounded p-3 grid grid-cols-[auto_1fr] gap-3 text-[13px]"><b className="text-[28px] font-semibold text-accent leading-none">{x.score.score}</b><div><span className="text-ok">Fits</span> {x.score.fits.join(' · ')}<br /><span className="text-warn">Missing</span> {x.score.missing.join(' · ') || '—'}<br /><span className="text-bad">Blocker</span> {x.score.blockers.join(' · ') || 'none'}</div></div>}
        {x.enrichError && <div className="mt-3 text-[13px] text-warn">The CV was read and the candidate saved, but preparing the client version failed: {x.enrichError}</div>}
        <div className="flex gap-2 mt-3"><PreviewPdf candidateId={x.candidate.id} disabled={!x.piiPassed} /><a className="btn" href={`/v/${x.candidate.reference_code.toLowerCase()}`} target="_blank">Preview verification page</a>{x.bullets && <button className="btn" onClick={() => navigator.clipboard.writeText(x.bullets.join('\n'))}>Copy bullets</button>}</div>
      </div><div className="border border-line rounded bg-[#FAFBFC] p-3 text-[12px] w-[220px] leading-relaxed"><b className="block text-[13px]">{x.candidate.reference_code}</b>{x.profile.trade}<br /><span className="bg-ink text-ink rounded-sm">name redacted</span><br />{(x.profile.certificates ?? []).slice(0, 2).join(' · ')}<br />{(x.profile.projects ?? []).slice(0, 2).map((p: any) => `${p.type}, ${p.country} ${p.years}`).join('; ')}<br />{(x.profile.languages ?? []).join(', ')}</div></div>)}
    </div>}
  </>);
}
