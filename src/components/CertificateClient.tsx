'use client';
import { useState } from 'react';
import { CertCard } from './CertCard';
import { friendlyError } from '@/lib/friendly-error';

/**
 * One drop zone, one question: what does this certificate say, and does the issuer confirm it?
 *
 * Verify takes everything a candidate sends and files it against a person. This screen does not: a recruiter
 * holding a ticket and asking "is this real, and what does it cover?" has no candidate in mind yet, and making
 * them walk past a CV anonymiser, a job-matching panel and a list of documents belonging to nobody to ask it
 * was the whole complaint. Verify is unchanged; this is a second front door onto the SAME code.
 *
 * Nothing here is new logic. The file goes through /api/verify/intake with mode=certificate_only — which
 * refuses anything that is not a certificate and attaches to nobody — and then /api/verify/lookup asks the
 * issuing body, exactly as Verify does. CertCard renders the same three layers: what the document says, what
 * the decode makes of it, and how far confirming it got.
 */
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

export function CertificateClient() {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [res, setRes] = useState<any>(null);

  const run = async (fileList: FileList | File[]) => {
    setErr(''); setRes(null);
    const files = Array.from(fileList);
    try {
      setBusy(`Reading ${files.length} file${files.length > 1 ? 's' : ''}…`);
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      // The one thing that makes this screen narrow. Everything else is Verify's own path.
      fd.append('mode', 'certificate_only');
      const intake = await call('/api/verify/intake', { method: 'POST', body: fd }, 150_000);

      // Only ever `loose`: mode=certificate_only attaches to nobody, so `candidates` is empty by construction.
      const state = { ...intake, loose: [...(intake.loose ?? [])] };
      setRes(state);
      const refresh = () => setRes({ ...state, loose: [...state.loose] });

      for (const f of state.loose.filter((x: any) => x.kind === 'certificate' && x.documentId)) {
        setBusy(`Checking ${f.extracted?.cert_body?.toUpperCase() ?? 'the certificate'} with the issuer…`);
        try {
          Object.assign(f, await call('/api/verify/lookup', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ document_id: f.documentId }),
          }));
        } catch (e: any) { f.lookupError = e.message; }
        refresh();
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy('');
    }
  };

  const loose: any[] = res?.loose ?? [];
  const certs = loose.filter((f) => f.kind === 'certificate');
  const refused = loose.filter((f) => f.kind !== 'certificate');

  return (<>
    <label
      data-certificate-drop
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) run(e.dataTransfer.files); }}
      className={`block border-2 border-dashed rounded-tile px-6 py-11 text-center cursor-pointer transition-colors ${over ? 'border-tool-verify bg-soft-verify' : 'border-[#C3CCD8] bg-panel hover:border-ink3'}`}
    >
      <span className="w-[58px] h-[58px] rounded-[16px] grid place-items-center bg-soft-verify text-tool-verify mx-auto mb-3">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="5" /><path d="M8.5 12.5 7 21l5-2.5 5 2.5-1.5-8.5" /></svg>
      </span>
      <b className="block font-display text-[18px] font-bold">Drop certificates here</b>
      <div className="text-ink3 text-[13px] mt-1">FROSIO, PCN, CSWIP, AMPP, IRATA, GWO, CISRS, welder ISO 9606, electrical · PDF or photo · several at once</div>
      <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.docx" className="hidden" disabled={!!busy} onChange={(e) => e.target.files && run(e.target.files)} />
      {/* The same hook Verify's zone carries: scripts wait on this, never on the wording, which changes with the step. */}
      <div data-verify-busy={busy ? 'true' : 'false'} className="text-tool-verify font-semibold text-[13px] mt-2.5">{busy || 'or click to choose'}</div>
    </label>

    {err && <div className="mt-4 bg-panel border border-bad rounded-card p-4 text-[13px]">
      <b className="text-bad">{friendlyError(err, 'certificate')}</b>
      <details className="mt-1 text-[12px] text-ink3"><summary className="cursor-pointer">Technical detail</summary><pre className="whitespace-pre-wrap mt-1">{err}</pre></details>
    </div>}

    {!res && !err && !busy && (
      <div className="text-ink3 text-[13px] mt-6">
        Drop a certificate — it is read, decoded against the standard it names, and checked with the issuing body where one publishes a register.
      </div>
    )}

    {/* A file that is not a certificate is refused and never stored: this screen does one thing, and silently
        filing someone's CV from here would be the opposite of that. It says where to take it instead. */}
    {refused.map((f, i) => (
      <div key={`r${i}`} data-certificate-refused className="mt-4 rounded-card border border-dashed border-line bg-panel p-4 text-[13px]">
        <b className="block">{f.file}</b>
        <span className="text-ink2">{f.why ?? 'not a certificate'}</span>
      </div>
    ))}

    {certs.length > 0 && (
      <div className="mt-6">
        <h2 className="mb-2.5 text-[13px] font-medium text-ink3">{certs.length} certificate{certs.length === 1 ? '' : 's'} read</h2>
        {certs.map((f, i) => (
          <div key={i} data-certificate-card className="mb-3.5 rounded-card border border-line bg-panel px-[18px] py-3.5">
            <CertCard res={f} busy={busy} />
            {f.lookupError && <div className="mt-2 text-[12px] text-bad">The issuer could not be asked: {f.lookupError}</div>}
          </div>
        ))}
        <div className="mt-3 text-[12px] text-ink3">
          Kept in Verify, under &ldquo;documents attached to nobody&rdquo;, until you put it on a candidate.
        </div>
      </div>
    )}
  </>);
}
