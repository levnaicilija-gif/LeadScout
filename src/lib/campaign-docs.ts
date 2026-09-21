import { SENDABLE, STATE_LABEL, type CertState } from '@/lib/verify/routes';

/**
 * Where a candidate stands on one required document — computed on read, never stored.
 *
 * Same rule as lead age (item 17) and compound signals (item 19): a status that is written down
 * drifts from the rows it describes the moment a certificate is checked or expires, and nothing tells
 * anyone. This reads the documents and their verifications every time and cannot go stale.
 *
 * THE STATES ARE NOT UNIFORM ACROSS TYPES, deliberately (owner's decision, 2026-09-21). Only a
 * certificate has anything behind the word "verified": item 23's adapters check it against the
 * issuer's own register and write documents.cert_state, and SENDABLE names the four states that
 * count as confirmed. Investigated before building, and the answer was narrower than the queue
 * item assumed:
 *
 *   certificate                             missing | received | verified | expired
 *   passport, medical, a1, contract,        missing | received      — and nothing more
 *   test_report, other
 *
 * A passport has no register to check against. The lookup route keys entirely on ext.cert_body and
 * writes 'unsupported' to anything without one, so a passport can only ever be "we hold the file".
 * The "name and expiry cross-check" the queue item refers to is holderFits (item 24 step 2) — a
 * name-fit gate at ATTACH time, asking whether this document belongs to this candidate. It applies to
 * every type equally and verifies nothing about a document's contents.
 *
 * So `verifiable` is on every row, and the screen says why a column is blank rather than leaving a
 * recruiter to read absence as failure. Inventing a verified state for a type with no check behind it
 * would be the same fabrication this codebase refuses everywhere else.
 */

export type DocState = 'missing' | 'received' | 'verified' | 'expired';

export type DocStatus = {
  /** The required document type, as stored on campaigns.required_docs. */
  type: string;
  state: DocState;
  /** Does a real verified state exist for this type at all? False means received is the ceiling. */
  verifiable: boolean;
  /** Plain English, always set — what was found, or why there is nothing more to say. */
  why: string;
  /** yyyy-mm-dd, only ever from verifications.valid_until, and only for certificates. */
  expiresOn: string | null;
};

/** The one type with a register behind it. Everything else is received-only. */
export const VERIFIABLE_TYPES = ['certificate'];
export const isVerifiable = (type: string) => VERIFIABLE_TYPES.includes(type);

/** A document as these functions need it — whatever loaded it. */
export type DocRow = {
  id: string;
  type: string | null;
  cert_state?: string | null;
  extracted?: { expiry?: string | null } | null;
};
/** A verification as these functions need it. `valid_until` is a real date column since dab0828. */
export type VerificationRow = { document_id: string; state?: string | null; result?: string | null; valid_until?: string | null };

const today = (now: Date) => now.toISOString().slice(0, 10);

/**
 * One required type for one candidate.
 *
 * Where a candidate holds several documents of a type — three certificates is normal — the BEST one
 * decides, because the question is "can this person go", not "is every file they ever sent perfect".
 * An expired certificate does not cancel a valid one; it only matters when nothing valid is held.
 */
export function docStatus(
  type: string,
  docs: DocRow[],
  verifications: VerificationRow[],
  now = new Date(),
): DocStatus {
  const verifiable = isVerifiable(type);
  const mine = docs.filter((d) => d.type === type);
  if (!mine.length) {
    return { type, state: 'missing', verifiable, why: 'no file on record', expiresOn: null };
  }

  if (!verifiable) {
    // Received is the ceiling, and the reason is carried so the screen never shows a bare blank.
    return {
      type,
      state: 'received',
      verifiable: false,
      why: `${mine.length === 1 ? 'file on record' : `${mine.length} files on record`} — there is no register to check a ${label(type)} against, so "received" is as far as this goes`,
      expiresOn: null,
    };
  }

  const byDoc = new Map<string, VerificationRow[]>();
  for (const v of verifications) {
    const list = byDoc.get(v.document_id) ?? [];
    list.push(v);
    byDoc.set(v.document_id, list);
  }

  const day = today(now);
  let best: DocStatus | null = null;
  let anyExpired: DocStatus | null = null;

  for (const d of mine) {
    // The document's own cert_state is what the lookup route wrote last; a verification's state is
    // the fallback for a row written before that column existed.
    const vs = byDoc.get(d.id) ?? [];
    const state = (d.cert_state ?? vs.map((v) => v.state).filter(Boolean)[0] ?? null) as CertState | null;
    // Only a real date counts. The printed text on the document is not one — it is kept as written,
    // in whatever form the certificate used, and reading it here is what put a European 03.09.2028
    // into the database as 9 March (fixed in dab0828).
    const validUntil = vs.map((v) => v.valid_until).filter(Boolean)[0] ?? null;
    const confirmed = !!state && (SENDABLE as string[]).includes(state);
    const expired = !!validUntil && validUntil < day;

    if (expired) {
      anyExpired = anyExpired ?? {
        type, state: 'expired', verifiable: true, expiresOn: validUntil,
        why: `expired on ${validUntil}${confirmed ? ', and it was confirmed before that' : ''}`,
      };
      continue;
    }
    if (confirmed) {
      const candidate: DocStatus = {
        type, state: 'verified', verifiable: true, expiresOn: validUntil,
        why: `${STATE_LABEL[state as CertState]}${validUntil ? `, valid to ${validUntil}` : ''}`,
      };
      // The one that runs longest wins, so a campaign reads the best cover the person actually has.
      if (!best || best.state !== 'verified' || (validUntil ?? '') > (best.expiresOn ?? '')) best = candidate;
      continue;
    }
    if (!best) {
      best = {
        type, state: 'received', verifiable: true, expiresOn: validUntil,
        why: state ? `on record — ${STATE_LABEL[state as CertState]}` : 'on record — not checked against the issuer yet',
      };
    }
  }

  // Everything held has expired: that is worth saying plainly rather than reporting "received".
  return best ?? anyExpired ?? { type, state: 'missing', verifiable, why: 'no file on record', expiresOn: null };
}

/** Every required type for one candidate. */
export const docStatuses = (required: string[], docs: DocRow[], verifications: VerificationRow[], now = new Date()) =>
  required.map((t) => docStatus(t, docs, verifications, now));

/**
 * Can this candidate's pack go to the client?
 *
 * Verified where a verified state exists, received where it does not, and nothing expired — the
 * definition the owner confirmed on 2026-09-21. It deliberately stops there: send-pack adds the other
 * precondition (a PII-passed client version) at the moment of sending, against the anonymised CV
 * rather than the required-documents list, and duplicating that test here would let the two drift.
 */
export function packReady(statuses: DocStatus[]): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  for (const s of statuses) {
    if (s.state === 'verified') continue;
    if (s.state === 'received' && !s.verifiable) continue;
    blockers.push(
      s.state === 'missing' ? `${label(s.type)} missing`
        : s.state === 'expired' ? `${label(s.type)} ${s.why}`
        : `${label(s.type)} on record but not confirmed with the issuer`,
    );
  }
  return { ready: blockers.length === 0, blockers };
}

/** "a1" reads as A1, "test_report" as test report — the words a recruiter uses. */
export function label(type: string): string {
  if (type === 'a1') return 'A1';
  if (type === 'cv') return 'CV';
  return type.replace(/_/g, ' ');
}
