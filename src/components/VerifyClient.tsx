'use client';
import { useState } from 'react';
import { PreviewPdf } from './PreviewPdf';
export function VerifyClient({ mode }: { mode: 'cert' | 'cv' }) {
  const [over, setOver] = useState(false); const [busy, setBusy] = useState(false); const [job, setJob] = useState(''); const [res, setRes] = useState<any>(null);
  const run = async (files: FileList | File[]) => {
    setBusy(true); const fd = new FormData();
    if (mode === 'cert') { fd.append('file', files[0]); const r = await fetch('/api/verify', { method: 'POST', body: fd }); setRes({ cert: await r.json() }); }
    else { for (const f of Array.from(files)) fd.append('files', f); if (job) fd.append('job', job); const r = await fetch('/api/anonymize', { method: 'POST', body: fd }); setRes({ cv: await r.json() }); }
    setBusy(false);
  };
  const Drop = ({ label, sub }: { label: string; sub: string }) => (<label onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); run(e.dataTransfer.files); }} className={`block border-[1.5px] border-dashed rounded bg-panel p-11 text-center cursor-pointer ${over ? 'border-accent bg-accentsoft' : 'border-[#B3BDCA]'}`}>
    <b className="block text-[15px] font-semibold">{label}</b><span className="text-ink3 text-[13px]">{sub}</span><input type="file" multiple={mode === 'cv'} accept=".pdf,.jpg,.jpeg,.png,.docx,.txt" className="hidden" onChange={(e) => e.target.files && run(e.target.files)} /><div className="mt-3 text-[13px] text-accent">{busy ? 'Working…' : 'or click to choose'}</div></label>);
  const KV = ({ rows }: { rows: [string, any][] }) => <div className="grid grid-cols-[130px_1fr] gap-y-1.5 text-[13px] mt-3">{rows.map(([k, v], i) => <><span key={'k' + i} className="text-ink3">{k}</span><span key={'v' + i}>{v ?? '—'}</span></>)}</div>;
  const v = res?.cert; const ver = v?.verification;
  return (<>
    {mode === 'cert' ? <Drop label="Drop a certificate here" sub="FROSIO, PCN, CSWIP, AMPP, IRATA, GWO, CISRS, welder ISO 9606, electrical · PDF or photo" />
      : <div className="grid grid-cols-2 gap-4"><Drop label="Drop CVs here" sub="Any language · PDF, DOCX, image or text · several at once" /><div className="bg-panel border border-line rounded"><div className="px-4 py-3 border-b border-line flex justify-between"><b className="font-semibold">Match against a job</b><span className="text-ink3 text-[12px]">optional</span></div><div className="p-3"><textarea value={job} onChange={(e) => setJob(e.target.value)} rows={6} placeholder="Paste a job description or posting…" className="w-full border border-line rounded px-2.5 py-2" /></div></div></div>}

    {v && <div className={`bg-panel border border-line rounded p-4 mt-4 grid grid-cols-[1fr_auto] gap-4`}>
      <div><div className="text-[17px] font-semibold flex items-center gap-2"><span className={`w-2.5 h-2.5 rounded-full ${ver?.result === 'valid' ? 'bg-ok' : ver?.result === 'pending' || ver?.result === 'consistent_with_test_report' ? 'bg-warn' : v.verdict?.result === 'needs_retake' ? 'bg-warn' : 'bg-bad'}`} />
        {ver?.result === 'valid' ? `Valid${ver.valid_until ? ` until ${ver.valid_until}` : ''}` : ver?.result === 'pending' ? ver.notes : ver?.result === 'consistent_with_test_report' ? 'Consistent with test report — issuer confirmation requested' : ver?.result === 'not_found' ? 'Not found on issuer site' : ver?.result === 'not_supported' ? 'No online register for this body — manual check' : v.verdict?.result === 'needs_retake' ? `Retake needed: ${v.verdict.unreadable.join(', ')}` : v.extracted?.doc_type !== 'certificate' ? `Read as ${v.extracted?.doc_type} — saved` : ver?.result}</div>
        <div className="text-ink3 text-[12px]">{v.extracted?.issuer} · {v.extracted?.level ?? v.extracted?.process} · No. {v.extracted?.number}</div>
        <KV rows={[['Holder', v.extracted?.holder], ['Checked where', ver?.checked_where ? <a className="text-accent" href={ver.checked_where} target="_blank">{ver.checked_where}</a> : '—'], ['Checked', ver?.checked_at ? new Date(ver.checked_at).toLocaleString() : '—'], ['Warnings', v.warnings?.length ? <span className="text-warn">{v.warnings.join(' · ')}</span> : 'none']]} />
        {v.issuerEmailDraft && <details className="mt-3 text-[13px]"><summary className="cursor-pointer text-accent">Issuer email — drafted, you send it</summary><pre className="whitespace-pre-wrap bg-[#FAFBFC] border border-line rounded p-3 mt-2">{v.issuerEmailDraft.subject}\n\n{v.issuerEmailDraft.body}</pre></details>}
      </div>
      {ver?.screenshot_path && <div className="w-[150px] h-[96px] border border-line rounded bg-line2 text-[10px] text-ink3 grid place-items-end p-1">screenshot saved</div>}
    </div>}

    {res?.cv && <div className="mt-4 grid gap-3">
      {res.cv.recommendation && <div className="bg-panel border border-line rounded p-4"><div className="text-[17px] font-semibold">Ranked against the job</div><table className="tbl w-full mt-3"><thead><tr><th>#</th><th>Candidate</th><th>Score</th><th>Fits</th><th>Missing</th><th>Blocker</th></tr></thead><tbody>{res.cv.results.map((x: any, i: number) => <tr key={i}><td>{i + 1}</td><td className="font-medium">{x.candidate.reference_code}</td><td className="text-accent font-semibold">{x.score?.score}</td><td>{x.score?.fits.join('; ')}</td><td>{x.score?.missing.join('; ')}</td><td className={x.score?.blockers.length ? 'text-bad' : ''}>{x.score?.blockers.join('; ') || '—'}</td></tr>)}</tbody></table><div className="mt-3 border-l-[3px] border-accent bg-accentsoft px-3 py-2 rounded-r text-[13px]"><b>Recommendation:</b> {res.cv.recommendation}</div></div>}
      {res.cv.results?.map((x: any, i: number) => <div key={i} className="bg-panel border border-line rounded p-4 grid grid-cols-[1fr_auto] gap-4"><div>
        <div className="text-[17px] font-semibold flex items-center gap-2"><span className={`w-2.5 h-2.5 rounded-full ${x.piiHits.length ? 'bg-bad' : 'bg-ok'}`} />{x.piiHits.length ? `Blocked: ${x.piiHits.join(', ')} in client text` : 'Anonymized CV ready'}</div>
        <div className="text-ink3 text-[12px]">reference {x.candidate.reference_code}</div>
        <KV rows={[['Removed', x.removed.join(', ')], ['Kept', 'trade, certificates with status, projects by type and country, rotations, languages, availability'], ['Certs in CV', `${x.crossCheck.claimed.length} claimed · ${x.crossCheck.verified} verified on file`]]} />
        <div className="text-[12px] text-ink3 mt-3 mb-1">Three bullets for the client</div><ul className="list-disc pl-5 text-[13px]">{x.bullets.map((b: string, j: number) => <li key={j}>{b}</li>)}</ul>
        {x.score && <div className="mt-3 border border-line rounded p-3 grid grid-cols-[auto_1fr] gap-3 text-[13px]"><b className="text-[28px] font-semibold text-accent leading-none">{x.score.score}</b><div><span className="text-ok">Fits</span> {x.score.fits.join(' · ')}<br /><span className="text-warn">Missing</span> {x.score.missing.join(' · ') || '—'}<br /><span className="text-bad">Blocker</span> {x.score.blockers.join(' · ') || 'none'}</div></div>}
        <div className="flex gap-2 mt-3"><PreviewPdf candidateId={x.candidate.id} disabled={!x.piiPassed} /><a className="btn" href={`/v/${x.candidate.reference_code.toLowerCase()}`} target="_blank">Preview verification page</a><button className="btn" onClick={() => navigator.clipboard.writeText(x.bullets.join('\n'))}>Copy bullets</button></div>
      </div><div className="border border-line rounded bg-[#FAFBFC] p-3 text-[12px] w-[220px] leading-relaxed"><b className="block text-[13px]">{x.candidate.reference_code}</b>{x.profile.trade}<br /><span className="bg-ink text-ink rounded-sm">name redacted</span><br />{x.profile.certificates.slice(0, 2).join(' · ')}<br />{x.profile.projects.slice(0, 2).map((p: any) => `${p.type}, ${p.country} ${p.years}`).join('; ')}<br />{x.profile.languages.join(', ')}</div></div>)}
    </div>}
  </>);
}
