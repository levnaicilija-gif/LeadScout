import { CERT_TABLE } from '@/lib/certs/tables';

/**
 * Who an expired certificate takes off the table, and for WHICH work — computed on read, never stored.
 *
 * The queue asks for "an expired certificate marks the candidate unavailable for roles that require
 * it". Investigated before building, and the shape of the data settles how:
 *
 *   candidates.availability_from is a DATE meaning "free from", not a flag. There is no boolean
 *   unavailable anywhere, and no per-role availability at all. Writing an expired certificate into
 *   availability_from would assert something different and false — "free from this date" — and would
 *   overwrite a real availability date a recruiter had entered. So nothing is written. This is
 *   computed on read, exactly as lead age (item 17) and compound signals (item 19) are, both of which
 *   this codebase keeps unstored on purpose: a stored verdict drifts from the rows it describes the
 *   moment a certificate is renewed, and nothing tells anyone.
 *
 * AND IT IS PER ROLE, because that is the only honest reading. The same welder is unavailable for
 * work that needs the certificate that lapsed and perfectly available for work that does not. A
 * global "unavailable" flag would be a lie in both directions: it would block them from work they can
 * do, and say nothing about which work they cannot.
 *
 * LAPSED IS NOT THE SAME AS NEVER HELD, and only the first is unavailability. Somebody who never had
 * a CSWIP is not "unavailable" for CSWIP work — they are simply not a candidate for it, which item 11's
 * scoring already says under `missing`. Somebody whose CSWIP ran out last month was placeable in
 * August and is not now, and that is the change worth surfacing. Treating the two alike would flood
 * the screen with everybody who does not hold every certificate.
 */

export type HeldCert = {
  /** documents.cert_body — frosio, cswip, pcn, iso9606 … */
  body: string | null | undefined;
  /** verifications.valid_until, a real date. Printed text is never a date here (see dab0828). */
  validUntil: string | null | undefined;
};

export type Unavailability = {
  unavailable: boolean;
  /** One line per certificate that lapsed, naming it and when — the words a recruiter repeats. */
  reasons: string[];
  /** The cert bodies the role asks for that this person cannot currently cover. */
  bodies: string[];
};

/**
 * Which certificate bodies a role is asking for, read from what the advert actually says.
 *
 * job_posts.certs_required is free text off the advert ("CSWIP 3.1", "FROSIO Level 3", "GWO BST"),
 * so the certificate library's own recognisers do the reading — the same table Verify decodes with.
 * Text nothing recognises contributes NOTHING rather than a guess: an unrecognised requirement is a
 * requirement we cannot reason about, and pretending otherwise would mark people unavailable for a
 * certificate nobody can name.
 */
export function bodiesRequired(certsRequired: (string | null | undefined)[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const raw of certsRequired ?? []) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    for (const entry of CERT_TABLE as any[]) {
      const body = String(entry.body);
      // The body's own name in the text, or a level recogniser that matches it.
      const named = new RegExp(`\\b${body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
        || (body === 'iso9606' && /9606/.test(text));
      if (named || (entry.match instanceof RegExp && entry.match.test(text) && new RegExp(body, 'i').test(text))) {
        out.add(body);
      }
    }
  }
  return [...out];
}

/** yyyy-mm-dd of today, in UTC — the same day boundary every other expiry rule here uses. */
const todayIso = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);

/**
 * Is this person unavailable for a role that asks for these certificates?
 *
 * Only where they HELD one of the required bodies and it has lapsed, with nothing valid of that body
 * behind it. A second, in-date certificate of the same body covers them — holding three is normal,
 * and the expired one is then just an old piece of paper.
 */
export function unavailableFor(held: HeldCert[], certsRequired: (string | null | undefined)[] | null | undefined, now = new Date()): Unavailability {
  const required = bodiesRequired(certsRequired);
  if (!required.length) return { unavailable: false, reasons: [], bodies: [] };

  const day = todayIso(now);
  const reasons: string[] = [];
  const bodies: string[] = [];

  for (const body of required) {
    const mine = held.filter((h) => String(h.body ?? '').toLowerCase() === body.toLowerCase());
    if (!mine.length) continue;                                   // never held: missing, not unavailable
    const valid = mine.some((h) => !h.validUntil || h.validUntil >= day);
    if (valid) continue;                                          // something in date covers it
    // Every one they hold of this body has run out. The latest of them is the one to quote.
    const latest = mine.map((h) => h.validUntil).filter(Boolean).sort().pop();
    bodies.push(body);
    reasons.push(`${body.toUpperCase()} expired ${latest ?? 'on a date the record does not give'}`);
  }

  return { unavailable: bodies.length > 0, reasons, bodies };
}

/**
 * The same question without a role: is anything they hold out of date at all?
 *
 * This is for the Candidates list, where there is no role in view — it says a certificate has lapsed
 * and names it, and deliberately does NOT say "unavailable", because without a role in front of it
 * that word would be a claim nobody can check.
 */
export function lapsedCerts(held: HeldCert[], now = new Date()): string[] {
  const day = todayIso(now);
  const byBody = new Map<string, HeldCert[]>();
  for (const h of held) {
    const b = String(h.body ?? '').toLowerCase();
    if (!b) continue;
    byBody.set(b, [...(byBody.get(b) ?? []), h]);
  }
  const out: string[] = [];
  for (const [body, list] of byBody) {
    if (list.some((h) => !h.validUntil || h.validUntil >= day)) continue;
    const latest = list.map((h) => h.validUntil).filter(Boolean).sort().pop();
    out.push(`${body.toUpperCase()} expired ${latest ?? 'on a date the record does not give'}`);
  }
  return out.sort();
}
