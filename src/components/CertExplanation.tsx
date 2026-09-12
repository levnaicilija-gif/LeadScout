'use client';
import { useEffect, useState } from 'react';
import type { Explanation } from '@/lib/certs/explain';

/**
 * What a certificate means, in three layers, under the raw designation rather than instead of it.
 *
 * The code stays visible: a welding engineer reads "138/136 T BW … H-L045 ssnb" faster than any
 * paragraph, and hiding it would make the decoding unauditable. Underneath it, for the recruiter
 * who cannot read it: what it says line by line, what the holder can do, what it does not cover.
 *
 * An unrecognised certificate says so. It does not get a blank space that reads like an answer.
 */
export function CertExplanation({
  body, level, scope, position, process, documentId, compact,
}: {
  body?: string | null; level?: string | null; scope?: string | null;
  position?: string | null; process?: string | null; documentId?: string | null; compact?: boolean;
}) {
  const [e, setE] = useState<Explanation | null>(null);
  const [failed, setFailed] = useState('');
  const [openCode, setOpenCode] = useState(false);

  useEffect(() => {
    if (!body && !scope) return;
    let gone = false;
    fetch('/api/cert-explain', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body, level, scope, position, process, documentId }),
    })
      .then((r) => r.json())
      .then((j) => { if (!gone) { if (j?.explanations?.[0]) setE(j.explanations[0]); else setFailed(j?.error ?? 'could not be explained'); } })
      .catch((x) => { if (!gone) setFailed(String(x?.message ?? x)); });
    return () => { gone = true; };
  }, [body, level, scope, position, process, documentId]);

  if (failed) return <div className="text-[12px] text-ink3 mt-2">Explanation unavailable — {failed}</div>;
  if (!e) return <div className="text-[12px] text-ink3 mt-2">Reading the code…</div>;

  if (!e.recognised) {
    return (
      <div className="mt-3 border border-warn rounded-card bg-warnsoft px-3.5 py-3 text-[13px]">
        <b className="text-warn font-semibold">Unrecognised — check</b>
        <div className="text-ink2 mt-1">{e.meaning}</div>
        <div className="text-ink3 text-[12px] mt-1">A senior has been asked to add it in Settings → Certificate library.</div>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="text-[12px] text-ink3 uppercase tracking-wide">What this certificate means</div>
        <span className="text-[11px] text-ink3">
          {e.source === 'workspace' ? 'from your library' : e.source === 'shipped' ? 'from the library' : e.source === 'decoder' ? 'decoded from the code' : 'from the certificate tables'}
        </span>
      </div>

      {/* The designation, verbatim, above everything derived from it. */}
      {e.raw && (
        <div className="mt-1.5 font-mono text-[12px] bg-[#FAFBFC] border border-line rounded px-3 py-2 break-words">{e.raw}</div>
      )}

      <div className="text-[13px] text-ink2 mt-2">{e.meaning}</div>

      {e.says.length > 0 && (
        <div className="mt-2">
          <button onClick={() => setOpenCode(!openCode)} className="text-[12px] text-accent font-semibold">
            {openCode ? 'Hide' : 'Show'} what the code says, line by line ({e.says.length})
          </button>
          {openCode && (
            <div className="mt-1.5 border border-line rounded-card overflow-hidden">
              {e.says.map((l, i) => (
                <div key={i} className="grid grid-cols-[92px_74px_minmax(0,1fr)] gap-2 px-3 py-2 border-t border-line2 first:border-t-0 text-[12.5px]">
                  <span className="text-ink3">{l.label}</span>
                  <span className="font-mono text-ink">{l.token}</span>
                  <span>
                    {l.says}
                    {l.range && <span className="block text-ink3 mt-0.5">→ {l.range}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={`grid gap-3 mt-3 ${compact ? '' : 'sm:grid-cols-2'}`}>
        {e.can.length > 0 && (
          <div>
            <div className="text-[12px] font-semibold text-ok">What the holder can do</div>
            <ul className="list-disc pl-[18px] text-[13px] mt-1 grid gap-1">{e.can.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
        )}
        {e.cannot.length > 0 && (
          <div>
            <div className="text-[12px] font-semibold text-warn">Does not cover</div>
            <ul className="list-disc pl-[18px] text-[13px] mt-1 grid gap-1 text-ink2">{e.cannot.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
        )}
      </div>

      {e.fits.length > 0 && (
        <div className="mt-2.5">
          <div className="text-[12px] font-semibold text-accent">Fits our jobs</div>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {e.fits.map((f, i) => <span key={i} className="text-[12px] px-2 py-0.5 rounded-md bg-accentsoft text-accent">{f}</span>)}
          </div>
        </div>
      )}

      {(e.whoRequires || e.validity || e.verification) && (
        <div className="grid grid-cols-[108px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px] mt-2.5">
          {e.whoRequires && <><span className="text-ink3">Who asks for it</span><span>{e.whoRequires}</span></>}
          {e.validity && <><span className="text-ink3">Typical validity</span><span>{e.validity}</span></>}
          {e.verification && <><span className="text-ink3">How it is checked</span><span>{e.verification}</span></>}
        </div>
      )}

      {e.confirm && (
        <div className="mt-2.5 text-[12px] text-warn border border-warn rounded px-3 py-2">
          A senior should confirm this before it is quoted to a client: {e.confirm}
        </div>
      )}

      {!!e.undecoded?.length && (
        <div className="mt-2 text-[12px] text-ink3">
          Read but not decoded here: {e.undecoded.join(', ')} — the printed certificate governs.
        </div>
      )}
    </div>
  );
}
