'use client';
import { useState } from 'react';
import { CertCard } from './CertCard';
import { JobPanel, SendToLead, type JobChoice } from './JobPanel';
import { AnonymizedPreview, DownloadPdf } from './CvCard';
import { PreviewPdf } from './PreviewPdf';
import { friendlyError } from '@/lib/friendly-error';

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
    if (e?.name === 'AbortError') throw new Error(`took longer than ${Math.round(timeoutMs / 1000)}s and was stopped`);
    throw e;
  } finally { clearTimeout(timer); }
}

const STEPS = ['Read', 'Anonymized', 'Bullets', 'PDF'];

/** Where a CV has got to: ✓ behind, · running, grey ahead. */
function Steps({ at, failed }: { at: number; failed?: boolean }) {
  return (
    <div className="flex gap-1.5 text-[12px] text-ink3 mt-2">
      {STEPS.map((s, i) => (
        <i key={s} className={`not-italic ${failed && i === at ? 'text-bad' : i < at ? 'text-ok' : i === at ? 'text-accent font-medium' : ''}`}>
          {i < at ? '✓ ' : i === at ? '· ' : ''}{s}
        </i>
      ))}
    </div>
  );
}

const KV = ({ rows }: { rows: [string, React.ReactNode][] }) => (
  <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-[13px] mt-2.5">
    {rows.map(([k, v], i) => <span key={'r' + i} className="contents"><span className="text-ink3">{k}</span><span>{v}</span></span>)}
  </div>
);

const shortName = (n: string) => { const p = n.trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0]; };
const dot = (t: 'ok' | 'warn' | 'bad' | 'none') => (t === 'ok' ? 'bg-ok' : t === 'warn' ? 'bg-warn' : t === 'bad' ? 'bg-bad' : 'bg-ink3');

export function VerifyClient({ senior }: { senior?: boolean }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [job, setJob] = useState<JobChoice | null>(null);
  const [res, setRes] = useState<any>(null);

  const run = async (fileList: FileList | File[]) => {
    setErr(''); setRes(null);
    const files = Array.from(fileList);
    try {
      setBusy(`Reading ${files.length} file${files.length > 1 ? 's' : ''}…`);
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      const intake = await call('/api/verify/intake', { method: 'POST', body: fd }, 150_000);

      // Show what each file turned out to be before any slow follow-up runs.
      const state = {
        ...intake,
        candidates: (intake.candidates ?? []).map((c: any) => ({ ...c, files: c.files.map((f: any) => ({ ...f, step: f.kind === 'cv' ? 1 : undefined })) })),
        loose: [...(intake.loose ?? [])],
      };
      setRes(state);
      const refresh = () => setRes({ ...state, candidates: [...state.candidates], loose: [...state.loose] });

      // Certificates: ask the issuing body, one at a time.
      const certs = [...state.candidates.flatMap((c: any) => c.files), ...state.loose].filter((f: any) => f.kind === 'certificate' && f.documentId);
      for (const f of certs) {
        setBusy(`Checking ${f.extracted?.cert_body?.toUpperCase() ?? 'the certificate'} with the issuer…`);
        try {
          Object.assign(f, await call('/api/verify/lookup', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ document_id: f.documentId }),
          }));
        } catch (e: any) { f.lookupError = e.message; }
        refresh();
      }

      // CVs: bullets, score, both PII gates and the client PDF, one candidate at a time.
      for (const c of state.candidates) {
        const cv = c.files.find((f: any) => f.kind === 'cv');
        if (!cv) continue;
        setBusy(`Preparing the client version for ${c.reference_code}…`);
        cv.step = 2; refresh();
        try {
          Object.assign(cv, await call('/api/anonymize/enrich', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ candidate_id: c.id, job: job?.jd || undefined }),
          }, 150_000), { step: 4 });
        } catch (e: any) { cv.enrichError = e.message; cv.failed = true; }
        refresh();
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally { setBusy(''); }
  };

  const clear = () => { setRes(null); setErr(''); setBusy(''); };

  const candidates = res?.candidates ?? [];
  const loose = res?.loose ?? [];
  const readyIds = candidates.filter((c: any) => c.files.some((f: any) => f.kind === 'cv' && f.piiPassed)).map((c: any) => c.id);

  return (<>
    <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] gap-4 items-start">
      <label
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) run(e.dataTransfer.files); }}
        className={`block border-[1.5px] border-dashed rounded bg-panel px-6 py-10 text-center cursor-pointer ${over ? 'border-accent bg-accentsoft' : 'border-[#B3BDCA]'}`}
      >
        <b className="block text-[16px] font-semibold">Drop any candidate documents here</b>
        <div className="text-ink3 text-[13px] mt-1">CVs, certificates, passport, contract, medical, A1, welding test report · PDF, DOCX or photo · any language · several at once</div>
        <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.docx,.txt" className="hidden" disabled={!!busy} onChange={(e) => e.target.files && run(e.target.files)} />
        <div className="text-accent text-[13px] mt-2.5">{busy || 'or click to choose'}</div>

        <div className="grid grid-cols-4 gap-2 mt-5 text-left">
          {[
            ['CV', 'Anonymized version, three client bullets, PDF to download'],
            ['Certificate', 'Checked with the issuer · what it covers · valid until'],
            ['Passport · contract', 'Name and expiry cross-checks · availability from contract end'],
            ['Medical · A1 · test report', 'Saved with dates on the candidate'],
          ].map(([t, d]) => (
            <div key={t} className="border border-line2 rounded px-3 py-2.5 bg-[#FAFBFC] text-[12.5px] leading-snug">
              <b className="block text-[13px] font-semibold mb-0.5">{t}</b>{d}
            </div>
          ))}
        </div>
      </label>

      <JobPanel value={job} onChange={setJob} />
    </div>

    {err && <div className="mt-4 bg-panel border border-bad rounded p-4 text-[13px]">
      <b className="text-bad">{friendlyError(err, 'cv')}</b>
      <details className="mt-1 text-[12px] text-ink3"><summary className="cursor-pointer">Technical detail</summary><pre className="whitespace-pre-wrap mt-1">{err}</pre></details>
    </div>}

    {!res && !err && !busy && <div className="text-ink3 text-[13px] mt-6">Drop a candidate&apos;s files — the app recognises each one and tells you what it did.</div>}

    {res && <>
      <div className="flex justify-between items-center mt-6 mb-2.5">
        <h2 className="text-[13px] text-ink3 font-medium m-0">{res.files} file{res.files === 1 ? '' : 's'} · {candidates.length} candidate{candidates.length === 1 ? '' : 's'} · recognised and handled</h2>
        <button className="btn" onClick={clear} disabled={!!busy}>Clear</button>
      </div>

      {job?.id && readyIds.length > 0 && (
        <div className="bg-panel border border-line rounded p-3 mb-3.5 flex flex-wrap gap-2 items-center text-[13px]">
          <b className="font-semibold">{job.label}</b>
          <span className="text-ink3">· {readyIds.length} candidate{readyIds.length === 1 ? '' : 's'} ready</span>
          <div className="flex-1" />
          <SendToLead leadId={job.id} leadLabel={job.label} candidateIds={readyIds} />
        </div>
      )}

      {candidates.map((c: any) => (
        <div key={c.id} className="bg-panel border border-line rounded mb-3.5">
          <div className="px-[18px] py-3 border-b border-line flex justify-between items-center">
            <b className="font-semibold">{c.reference_code}{c.full_name ? ` · ${shortName(c.full_name)}` : ''}</b>
            <span className="text-[12px] text-ink3">{c.files.some((f: any) => f.kind === 'cv') ? 'new candidate created from CV' : 'matched to existing candidate by name on document'} · {c.files.length} file{c.files.length === 1 ? '' : 's'}</span>
          </div>
          {c.files.map((f: any, i: number) => <FileCard key={i} f={f} candidate={c} senior={senior} job={job} busy={busy} />)}
        </div>
      ))}

      {loose.map((f: any, i: number) => (
        <div key={'l' + i} className={`bg-panel border rounded mb-3.5 ${f.kind === 'other' || f.kind === 'unreadable' ? 'border-dashed' : ''} border-line`}>
          <FileCard f={f} senior={senior} job={job} busy={busy} />
        </div>
      ))}
    </>}
  </>);
}

/** One file, headlined by what it turned out to be. */
function FileCard({ f, candidate, senior, job, busy }: { f: any; candidate?: any; senior?: boolean; job?: JobChoice | null; busy?: string }) {
  if (f.kind === 'other' || f.kind === 'unreadable') {
    return (
      <div className="px-[18px] py-3.5">
        <div className="text-[15px] font-semibold flex items-center gap-2"><span className={`w-2.5 h-2.5 rounded-full ${dot('bad')}`} />Not a candidate document — not saved</div>
        <div className="text-ink3 text-[12px] mt-0.5">{f.file}{f.why ? ` · ${friendlyError(f.why, 'cv')}` : ''}</div>
        {f.why && <details className="mt-1 text-[12px] text-ink3"><summary className="cursor-pointer">Technical detail</summary><pre className="whitespace-pre-wrap mt-1">{f.why}</pre></details>}
      </div>
    );
  }

  if (f.kind === 'certificate') return <div className="px-[18px] py-3.5 border-b border-line2 last:border-b-0"><CertCard res={f} busy={busy} /></div>;

  if (f.kind === 'cv') {
    return (
      <div className="px-[18px] py-3.5 grid grid-cols-[1fr_auto] gap-4 border-b border-line2 last:border-b-0">
        <div>
          <div className="text-[15px] font-semibold flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${dot(f.piiHits?.length ? 'bad' : f.step === 4 ? 'ok' : 'none')}`} />
            CV — {f.trade ?? f.profile?.trade ?? 'trade not stated'} · {f.piiHits?.length ? 'blocked by the PII check' : f.step === 4 ? 'anonymized' : 'reading'} · {f.reference}
          </div>
          <div className="text-ink3 text-[12px] mt-0.5">{f.file}</div>
          <Steps at={f.step ?? 1} failed={f.failed} />

          <KV rows={[
            ['Removed', 'name, phone, email, address, photo, date of birth, employer names'],
            ['Kept', 'trade, certificates with status, projects by type and country, rotations, languages, availability'],
            ['Certs in CV', `${f.crossCheck?.claimed ?? (f.profile?.certificates ?? []).length} claimed · ${f.crossCheck?.verified ?? 0} verified on file${(f.crossCheck?.verified ?? 0) === 0 ? ' — drop the certificates to check them' : ''}`],
          ]} />

          {f.piiHits?.length > 0 && <div className="mt-2 text-[13px] text-bad">Blocked: {f.piiHits.join(', ')}</div>}
          {f.droppedBullets?.length > 0 && <div className="mt-2 text-[12px] text-warn">Dropped {f.droppedBullets.length} bullet(s) that could not be traced to the CV.</div>}
          {f.enrichError && <div className="mt-2 text-[13px] text-warn">The CV was read and the candidate saved, but the client version could not be prepared. <details className="inline"><summary className="cursor-pointer inline text-ink3">detail</summary><pre className="whitespace-pre-wrap mt-1 text-[12px]">{f.enrichError}</pre></details></div>}

          {f.bullets?.length > 0 && <>
            <div className="text-[12px] text-ink3 mt-2.5">Three bullets for the client — facts only</div>
            <ul className="list-disc pl-[18px] text-[13px] mt-1">{f.bullets.map((b: string, i: number) => <li key={i} className="mb-0.5">{b}</li>)}</ul>
          </>}

          {f.score && <div className="border border-line rounded px-3 py-2.5 mt-3 grid grid-cols-[auto_1fr] gap-3.5 text-[13px] leading-relaxed">
            <b className="text-[26px] font-semibold text-accent leading-none">{f.score.score}</b>
            <div>
              <span className="text-ok">Fits</span> {f.score.fits.join(' · ') || '—'}<br />
              <span className="text-warn">Missing</span> {f.score.missing.join(' · ') || '—'}<br />
              <span className="text-bad">Blocker</span> {f.score.blockers.join(' · ') || 'none'}{job?.label ? <span className="text-ink3"> · vs {job.label}</span> : null}
            </div>
          </div>}

          {f.step === 4 && <AnonymizedPreview x={{ candidate: { id: candidate?.id, reference_code: f.reference }, profile: f.profile, bullets: f.bullets, certificates: f.certificates }} />}

          <div className="flex gap-2 mt-3 flex-wrap">
            <DownloadPdf candidateId={candidate?.id} kind="client" label="Download client PDF" disabled={!f.piiPassed} />
            {f.bullets && <button className="btn" onClick={() => navigator.clipboard.writeText(f.bullets.join('\n'))}>Copy bullets</button>}
            <a className="btn" href={`/v/${String(f.reference ?? '').toLowerCase()}`} target="_blank" rel="noopener">Preview verification page</a>
            <PreviewPdf candidateId={candidate?.id} disabled={!f.piiPassed} />
            <DownloadPdf candidateId={candidate?.id} kind="internal" label="Internal PDF" senior={senior} />
          </div>
        </div>

        <div className="w-[210px] border border-line rounded px-3 py-2.5 bg-[#FAFBFC] text-[12px] leading-relaxed">
          <b className="block text-[13px]">{f.reference}</b>
          {f.profile?.trade}<br />
          <span className="bg-ink text-ink rounded-sm">name redacted</span><br />
          {(f.profile?.projects ?? []).slice(0, 2).map((p: any, i: number) => <span key={i}>{[p.type, p.country, p.years].filter(Boolean).join(', ')}<br /></span>)}
          {(f.profile?.languages ?? []).join(', ')}<br />
          {f.profile?.availability}
        </div>
      </div>
    );
  }

  // Contract, passport, medical, A1, welding test report.
  const e = f.extracted ?? {};
  const headline =
    f.kind === 'contract'
      ? `Contract — ${[e.employer, e.role].filter(Boolean).join(', ')}${e.end ? `, until ${e.end}` : ''}${f.availabilitySet ? ` · availability set to ${f.availabilitySet}` : ''}`
      : f.kind === 'passport'
        ? `Passport — ${e.expiry ? `expires ${e.expiry}` : 'no expiry read'}${f.nameMatches === true ? ' · name matches certificates' : f.nameMatches === false ? ' · name does NOT match certificates' : ''}`
        : `${f.kind === 'a1' ? 'A1' : f.kind === 'test_report' ? 'Welding test report' : f.kind.charAt(0).toUpperCase() + f.kind.slice(1)} — saved${e.expiry ? ` · valid to ${e.expiry}` : ''}`;

  return (
    <div className="px-[18px] py-3.5 border-b border-line2 last:border-b-0">
      <div className="text-[15px] font-semibold flex items-center gap-2">
        <span className={`w-2.5 h-2.5 rounded-full ${dot(f.nameMatches === false ? 'bad' : 'none')}`} />{headline}
      </div>
      <div className="text-ink3 text-[12px] mt-0.5">{f.file}{f.kind === 'contract' ? ' · employment agreement' : ''}</div>

      {f.kind === 'contract' && <KV rows={[
        ['Employer', <>{e.employer ?? '—'} · <span className="text-ink3">internal only</span></>],
        ['Workplace', [e.workplace, e.rotation].filter(Boolean).join(' · ') || '—'],
        ['Ends', e.end ? <>{e.end} → availability {f.availabilitySet ?? '—'}, editable</> : '—'],
        ['Not stored', 'rate, allowances, pension, date of birth'],
      ]} />}

      {f.kind === 'passport' && <KV rows={[
        ['Holder', e.holder ?? '—'],
        ['Expires', e.expiry ?? '—'],
        ['Cross-check', f.checkedAgainst ? `${f.nameMatches ? 'matches' : 'does not match'} ${f.checkedAgainst} certificate(s) on file` : 'no certificates on file yet'],
      ]} />}
    </div>
  );
}
