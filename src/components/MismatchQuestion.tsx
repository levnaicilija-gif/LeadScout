'use client';
import { candidateLabel } from '@/lib/candidate-number';

/**
 * "This certificate is for Paul Daniel Pascale — this candidate is Bertescu Dumitrel. Attach anyway, or open a record for
 * Paul Daniel Pascale instead?"
 *
 * Asked whenever the name on a document does not fit the candidate it is about to go on (name-match.ts#holderFits): on a
 * candidate's page after a drop, and on Verify's cards when a recruiter picks someone (item 24 follow-up, 2026-09-15 —
 * Paul Daniel Pascale's FROSIO certificate went onto #9 and nothing asked). Nothing is attached until one of the two is
 * pressed; until then the document waits among Verify's unattached documents. "Attach anyway" is for the genuine edge
 * case (a maiden name, a name the certificate misspells) and is recorded as that.
 */
export type Mismatch = { holder: string | null; candidate: { id: string; reference: string; name: string | null }; why: string; type?: string };

export function MismatchQuestion({ mismatch, type, busy, onAttachAnyway, onOpenRecord }: {
  mismatch: Mismatch;
  type?: string;
  busy?: string;
  onAttachAnyway: () => void;
  onOpenRecord?: () => void;
}) {
  const kind = type ?? mismatch.type;
  const what = kind === 'cv' ? 'CV' : kind === 'certificate' ? 'certificate' : 'document';
  const who = mismatch.candidate.name ?? candidateLabel(mismatch.candidate.reference);
  return (
    <div data-mismatch-question className="border border-warn bg-warnsoft rounded-card p-3 text-[13px] mt-2">
      <b className="block font-semibold" data-mismatch-text>
        {mismatch.holder
          ? `This ${what} is for ${mismatch.holder} — this candidate is ${who}.`
          : `No name could be read from this ${what}, so it cannot be checked against ${who}.`}
      </b>
      <div className="text-ink2 mt-0.5">
        {mismatch.holder ? `Attach anyway, or open a record for ${mismatch.holder} instead?` : 'Attach anyway, or leave it unattached?'}
        {' '}Nothing is attached until you choose — it waits among Verify&apos;s unattached documents.
      </div>
      <div className="flex flex-wrap gap-2 mt-2.5">
        {mismatch.holder && onOpenRecord && (
          <button type="button" data-mismatch-open disabled={!!busy} onClick={onOpenRecord} className="btn btn-primary text-[13px] disabled:opacity-60">
            {busy === 'new' ? 'Opening…' : `Open a record for ${mismatch.holder}`}
          </button>
        )}
        <button type="button" data-mismatch-attach disabled={!!busy} onClick={onAttachAnyway} className="btn text-[13px] disabled:opacity-60">
          {busy === 'anyway' ? 'Attaching…' : `Attach to ${candidateLabel(mismatch.candidate.reference)} anyway`}
        </button>
      </div>
    </div>
  );
}
