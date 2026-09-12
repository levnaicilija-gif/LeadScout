'use client';
import { useEffect, useState } from 'react';

/**
 * Whose document is this?
 *
 * Shown whenever intake could not answer it by itself. The offers are the near matches, each
 * with the reason it is being offered, because "Attach?" on its own asks the recruiter to guess
 * along with us — and a welder's ticket on the wrong welder puts an unqualified man on a plane.
 *
 * Opening a record from the document is the other honest answer, and it is deliberately a
 * button rather than something intake does: a certificate says what a person can do, not that
 * we have them.
 */
type Suggestion = { candidateId: string; reference: string; name?: string | null; kind: 'exact' | 'near'; why: string };

export function AttachChoice({
  documentId, holder, suggest, onDone, compact,
}: {
  documentId: string;
  holder?: string | null;
  suggest?: Suggestion[];
  onDone?: (r: { reference: string; created: boolean }) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ reference: string; created: boolean } | null>(null);
  const [all, setAll] = useState<{ id: string; reference: string; name?: string | null }[] | null>(null);
  const [picked, setPicked] = useState('');
  const [offers, setOffers] = useState<Suggestion[]>(suggest ?? []);

  // A card rendered from stored rows has no suggestions with it; fetch them once.
  useEffect(() => {
    if (suggest || !documentId) return;
    let gone = false;
    fetch(`/api/verify/attach?documentId=${documentId}`)
      .then((r) => r.json())
      .then((j) => { if (!gone && j?.suggestions) { setOffers(j.suggestions); setAll(j.candidates ?? []); } })
      .catch(() => {});
    return () => { gone = true; };
  }, [documentId, suggest]);

  const post = async (body: any, what: string) => {
    setBusy(what); setErr('');
    try {
      const r = await fetch('/api/verify/attach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentId, ...body }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `attach failed (HTTP ${r.status})`);
      const result = { reference: j.candidate?.reference ?? '', created: !!j.created };
      setDone(result);
      onDone?.(result);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(''); }
  };

  const loadAll = async () => {
    if (all) return;
    const r = await fetch(`/api/verify/attach?documentId=${documentId}`).then((x) => x.json()).catch(() => null);
    setAll(r?.candidates ?? []);
  };

  if (done) {
    return (
      <div className={`text-[13px] text-ok ${compact ? '' : 'mt-2'}`}>
        ✓ {done.created ? 'Record opened' : 'Attached'} — {done.reference}
      </div>
    );
  }

  return (
    <div className={`${compact ? '' : 'mt-2.5'} border border-line rounded-card p-3 bg-[#FAFBFC] text-[13px]`}>
      <b className="block font-semibold">Who is this document for?</b>
      <div className="text-ink3 text-[12px] mt-0.5">
        {holder ? <>The document says <b className="text-ink2 font-medium">{holder}</b>.</> : 'No holder name could be read from it.'}
        {' '}Nothing is attached until you choose.
      </div>

      {offers.length > 0 && (
        <div className="grid gap-1.5 mt-2.5">
          {offers.map((s) => (
            <button
              key={s.candidateId}
              disabled={!!busy}
              onClick={() => post({ candidateId: s.candidateId, reason: `attached on the card — ${s.why}` }, s.reference)}
              className="text-left border border-line rounded px-3 py-2 bg-panel hover:border-accent disabled:opacity-60"
            >
              <b className="font-semibold">Attach to {s.reference}</b>
              {s.name ? <span className="text-ink2"> · {s.name}</span> : null}
              <span className={`badge ml-2 ${s.kind === 'exact' ? 'badge-ok' : 'badge-warn'}`}>{s.kind === 'exact' ? 'name matches' : 'similar name'}</span>
              <div className="text-ink3 text-[12px] mt-0.5">{s.why}</div>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center mt-2.5">
        {holder && (
          <button disabled={!!busy} onClick={() => post({ create: true }, 'new')} className="btn btn-primary text-[13px] disabled:opacity-60">
            {busy === 'new' ? 'Opening…' : 'Open a record for this person'}
          </button>
        )}
        {all === null
          ? <button disabled={!!busy} onClick={loadAll} className="btn text-[13px]">Attach to someone else…</button>
          : (
            <span className="flex gap-2 items-center">
              <select value={picked} onChange={(e) => setPicked(e.target.value)} className="border border-line rounded px-2 py-1.5 bg-panel text-[13px]">
                <option value="">Choose a candidate…</option>
                {all.map((c) => <option key={c.id} value={c.id}>{c.reference}{c.name ? ` · ${c.name}` : ''}</option>)}
              </select>
              <button
                disabled={!picked || !!busy}
                onClick={() => post({ candidateId: picked, reason: 'chosen by hand on the card' }, 'pick')}
                className="btn text-[13px] disabled:opacity-60"
              >Attach</button>
            </span>
          )}
      </div>

      {err && <div className="text-bad mt-2 text-[12px]">{err}</div>}
    </div>
  );
}
