'use client';
import { useState } from 'react';
import { PreviewPdf } from './PreviewPdf';
import { Progress, AnonymizedPreview, DownloadPdf, type Stage } from './CvCard';
import { friendlyError } from '@/lib/friendly-error';
import { CertCard } from './CertCard';
import { JobPanel, SendToLead, type JobChoice } from './JobPanel';

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

export function VerifyClient({ mode, senior }: { mode: 'cert' | 'cv'; senior?: boolean }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [job, setJob] = useState<JobChoice | null>(null);
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

        // Every candidate carries its own stage, so a card never reads "ready" while its
        // client version is still being built.
        const out = (step1.results ?? []).map((r: any) => ({ ...r, stage: 'anonymising' as Stage }));
        setRes({ cv: { ...step1, results: [...out] } });

        for (let i = 0; i < out.length; i++) {
          setBusy(`Preparing the client version (${i + 1} of ${out.length})…`);
          out[i] = { ...out[i], stage: 'bullets' as Stage };
          setRes({ cv: { ...step1, results: [...out] } });
          try {
            const enriched = await call('/api/anonymize/enrich', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ candidate_id: out[i].candidate.id, job: job?.jd || undefined }),
            });
            out[i] = { ...out[i], ...enriched, stage: 'done' as Stage };
          } catch (e: any) {
            out[i] = { ...out[i], enrichError: e.message, stage: 'failed' as Stage };
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

  const clear = () => { setRes(null); setErr(''); setBusy(''); };

  const Drop = ({ label, sub }: { label: string; sub: string }) => (
    <label onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); run(e.dataTransfer.files); }} className={`block border-[1.5px] border-dashed rounded bg-panel p-11 text-center cursor-pointer ${over ? 'border-accent bg-accentsoft' : 'border-[#B3BDCA]'}`}>
      <b className="block text-[15px] font-semibold">{label}</b><span className="text-ink3 text-[13px]">{sub}</span>
      <input type="file" multiple={mode === 'cv'} accept=".pdf,.jpg,.jpeg,.png,.docx,.txt" className="hidden" disabled={!!busy} onChange={(e) => e.target.files && run(e.target.files)} />
      <div className="mt-3 text-[13px] text-accent">{busy || 'or click to choose'}</div>
    </label>);

  const KV = ({ rows }: { rows: [string, any][] }) => <div className="grid grid-cols-[130px_1fr] gap-y-1.5 text-[13px] mt-3">{rows.map(([k, v], i) => <><span key={'k' + i} className="text-ink3">{k}</span><span key={'v' + i}>{v ?? '—'}</span></>)}</div>;

  const v = res?.cert; const ver = v?.verification;

  return (<>
    {(res || err) && !busy && <div className="flex justify-end mb-2"><button className="btn" onClick={clear}>Clear</button></div>}

    {mode === 'cert' ? <Drop label="Drop a certificate here" sub="FROSIO, PCN, CSWIP, AMPP, IRATA, GWO, CISRS, welder ISO 9606, electrical · PDF or photo" />
      : <div className="grid grid-cols-2 gap-4">
        <Drop label="Drop CVs here" sub="Any language · PDF, DOCX, image or text · several at once" />
        <JobPanel value={job} onChange={setJob} />
      </div>}

    {err && <div className="mt-4 bg-panel border border-bad rounded p-4 text-[13px]"><b className="text-bad">{friendlyError(err, mode === 'cv' ? 'cv' : 'certificate')}</b><details className="mt-1 text-[12px] text-ink3"><summary className="cursor-pointer">Technical detail</summary><pre className="whitespace-pre-wrap mt-1">{err}</pre></details></div>}

    {v && <CertCard res={v} busy={busy} />}

    {res?.cv && job?.id && (res.cv.results ?? []).some((x: any) => x.piiPassed) && (
      <div className="bg-panel border border-line rounded p-3 mt-4 flex flex-wrap gap-2 items-center text-[13px]">
        <b className="font-semibold">{job.label}</b>
        <span className="text-ink3">· {(res.cv.results ?? []).filter((x: any) => x.piiPassed).length} candidate(s) ready</span>
        <div className="flex-1" />
        <SendToLead leadId={job.id} leadLabel={job.label} candidateIds={(res.cv.results ?? []).filter((x: any) => x.piiPassed).map((x: any) => x.candidate.id)} />
      </div>
    )}

    {res?.cv && <div className="mt-4 grid gap-3">
      {(res.cv.failed ?? []).map((f: any, i: number) => (
        <div key={'f' + i} className="bg-panel border border-bad rounded p-3 text-[13px]">
          <b className="text-bad">{f.file}</b> — {friendlyError(f.why, 'cv')}
          <details className="mt-1 text-[12px] text-ink3"><summary className="cursor-pointer">Technical detail</summary><pre className="whitespace-pre-wrap mt-1">{f.why}</pre></details>
        </div>
      ))}

      {res.cv.results?.map((x: any, i: number) => {
        const blocked = x.piiHits?.length > 0;
        const headline = blocked ? `Blocked: ${x.piiHits.join(', ')}`
          : x.stage === 'done' ? 'Anonymized CV ready'
            : x.stage === 'failed' ? 'Could not finish the client version'
              : 'Working on the client version…';
        const dot = blocked || x.stage === 'failed' ? 'bg-bad' : x.stage === 'done' ? 'bg-ok' : 'bg-accent';
        return (
          <div key={i} className="bg-panel border border-line rounded p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[17px] font-semibold flex items-center gap-2"><span className={`w-2.5 h-2.5 rounded-full ${dot}`} />{headline}</div>
                <div className="text-ink3 text-[12px]">reference {x.candidate.reference_code}{x.file ? ` · ${x.file}` : ''}</div>
                <Progress stage={x.stage ?? 'read'} />
              </div>
              <div className="text-[12px] text-ink3 text-right whitespace-nowrap">{x.crossCheck?.claimed ?? 0} claimed · {x.crossCheck?.verified ?? 0} verified</div>
            </div>

            {x.droppedBullets?.length > 0 && <div className="mt-2 text-[12px] text-warn">Dropped {x.droppedBullets.length} bullet(s) that could not be traced to the CV.</div>}
            {x.enrichError && <div className="mt-2 text-[13px] text-warn">The CV was read and the candidate saved, but the client version could not be prepared. <details className="inline text-[12px] text-ink3"><summary className="cursor-pointer inline">detail</summary><pre className="whitespace-pre-wrap mt-1">{x.enrichError}</pre></details></div>}

            <AnonymizedPreview x={x} />

            {x.score && <div className="mt-3 border border-line rounded p-3 grid grid-cols-[auto_1fr] gap-3 text-[13px]"><b className="text-[28px] font-semibold text-accent leading-none">{x.score.score}</b><div><span className="text-ok">Fits</span> {x.score.fits.join(' · ')}<br /><span className="text-warn">Missing</span> {x.score.missing.join(' · ') || '—'}<br /><span className="text-bad">Blocker</span> {x.score.blockers.join(' · ') || 'none'}</div></div>}

            <div className="flex gap-2 mt-3 flex-wrap">
              <PreviewPdf candidateId={x.candidate.id} disabled={!x.piiPassed} />
              <DownloadPdf candidateId={x.candidate.id} kind="client" label="Download client PDF" disabled={!x.piiPassed} />
              <DownloadPdf candidateId={x.candidate.id} kind="internal" label="Download internal PDF" senior={senior} />
              <a className="btn" href={`/v/${x.candidate.reference_code.toLowerCase()}`} target="_blank">Verification page</a>
              {x.bullets && <button className="btn" onClick={() => navigator.clipboard.writeText(x.bullets.join('\n'))}>Copy bullets</button>}
            </div>
          </div>
        );
      })}
    </div>}
  </>);
}
