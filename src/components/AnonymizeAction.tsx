'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PreviewPdf } from './PreviewPdf';
import { DownloadPdf } from './CvCard';

/**
 * "Generate anonymized version" on a candidate's page (item 24): the existing CV anonymiser — client bullets and their
 * audit, the two-line summary, both PII checks and the client PDF (api/anonymize/enrich) — run for this candidate, rather
 * than as a separate Verify flow. A PDF that fails the PII check is never stored, and the result says what blocked it.
 * The latest version already on file is shown with its own preview and download.
 */
export type AnonVersion = { generatedAt: string; piiPassed: boolean; hasPdf: boolean };

export function AnonymizeAction({ candidateId, latest, senior, hasCv }: { candidateId: string; latest: AnonVersion | null; senior: boolean; hasCv: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<any>(null);

  const run = async () => {
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await fetch('/api/anonymize/enrich', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidate_id: candidateId }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) throw new Error(j?.error ?? `the anonymized version could not be made (HTTP ${r.status})`);
      setResult(j);
      router.refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(false); }
  };

  const ready = result ? result.piiPassed && !!result.pdfPath : latest ? latest.piiPassed && latest.hasPdf : false;
  return (
    <div className="grid gap-3 text-[13px]" data-anonymize>
      {latest && !result && <div className="text-ink2" data-anonymize-latest>Latest version {new Date(latest.generatedAt).toLocaleString('en-GB')} · {latest.piiPassed ? <span className="text-ok">passed the PII check</span> : <span className="text-bad">blocked by the PII check — not stored</span>}</div>}
      {result && (
        <div className="grid gap-1.5" data-anonymize-result={result.piiPassed ? 'passed' : 'blocked'}>
          <div className={result.piiPassed ? 'text-ok font-semibold' : 'text-bad font-semibold'}>{result.piiPassed ? 'Anonymized version made — it passed the PII check' : 'Blocked by the PII check — the client PDF was not stored'}</div>
          {(result.summary ?? []).length > 0 && <div className="text-ink2">{result.summary.join(' ')}</div>}
          {(result.bullets ?? []).length > 0 && <ul className="m-0 pl-4 grid gap-0.5">{result.bullets.map((b: string, i: number) => <li key={i}>{b}</li>)}</ul>}
          {(result.piiHits ?? []).length > 0 && <div className="text-bad text-[12px]">Found: {result.piiHits.join(' · ')}</div>}
        </div>
      )}
      {err && <div className="text-bad" data-anonymize-error>{err}</div>}
      <div className="flex flex-wrap gap-2 items-center">
        <button type="button" className="btn btn-primary" onClick={run} disabled={busy || !hasCv} data-anonymize-run>{busy ? 'Making the anonymized version…' : latest || result ? 'Generate a new anonymized version' : 'Generate anonymized version'}</button>
        {ready && <PreviewPdf candidateId={candidateId} label="Preview client PDF" />}
        {ready && <DownloadPdf candidateId={candidateId} kind="client" label="Client PDF" />}
        <DownloadPdf candidateId={candidateId} kind="internal" label="Internal PDF" senior={senior} />
      </div>
      {!hasCv && <div className="text-ink3 text-[12px]">An anonymized version is made from the CV — add one first.</div>}
    </div>
  );
}
