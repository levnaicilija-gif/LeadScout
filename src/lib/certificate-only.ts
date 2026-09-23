/**
 * "Unconfirmed · certificate-only" — a real record, with a real document, and no CV behind it yet.
 *
 * Item 25 opens a record from a certificate that matches nobody. That record is not a candidate in
 * the ordinary sense: nobody has seen this person's history, nobody knows whether they are available
 * or even reachable. A ticket says what somebody CAN DO, not that we have them — the rule Verify's
 * intake already states in its own words — so the record has to read as exactly that wherever it
 * appears, or a recruiter will put a name in front of a client on the strength of a PDF.
 *
 * COMPUTED ON READ, NEVER STORED, for the reason this codebase keeps rediscovering: a stored flag
 * has to be cleared by whoever later attaches the CV, and the one that is missed leaves a full
 * candidate reading "certificate-only" for ever, or worse, the reverse. Lead age (item 17), compound
 * signals (item 19) and the scorecard (item 11) are all computed for the same reason. Here the
 * question is answered by a fact already on file — is there a CV on this person — so it cannot drift,
 * and it stops being true by itself the moment a CV is attached.
 */

export const CERTIFICATE_ONLY_LABEL = 'unconfirmed · certificate-only';

/** What the record is missing, in a recruiter's words, for the line under the label. */
export const CERTIFICATE_ONLY_NOTE =
  'Opened from a certificate. No CV on file, so nothing is known about their history, availability or notice.';

export type DocLike = { type?: string | null };

/**
 * Is this record standing on a certificate alone?
 *
 * The test is the ABSENCE OF A CV, not the presence of a certificate: a record opened from a medical
 * or a passport is in exactly the same position, and a record with a CV is not certificate-only
 * however many certificates it also has.
 */
export function isCertificateOnly(documents: DocLike[] | null | undefined): boolean {
  const docs = documents ?? [];
  // No documents at all is a manually typed record, not a certificate-only one — it was somebody's
  // deliberate act rather than a side effect of checking a ticket, and labelling it would be a
  // claim about where it came from that nothing on file supports.
  if (!docs.length) return false;
  return !docs.some((d) => String(d?.type ?? '').toLowerCase() === 'cv');
}

/** The label and its note, or null where the record is an ordinary one. */
export function certificateOnlyBadge(documents: DocLike[] | null | undefined): { label: string; note: string } | null {
  return isCertificateOnly(documents) ? { label: CERTIFICATE_ONLY_LABEL, note: CERTIFICATE_ONLY_NOTE } : null;
}
