/**
 * One explanation for any certificate, from three sources in a fixed order of precedence.
 *
 *   1. the workspace's own library row, if a senior has written one
 *   2. the shipped library row
 *   3. the code tables — the ISO 9606 decoder, or src/lib/certs/tables.ts
 *
 * A senior's correction wins over what we shipped, and what we shipped wins over nothing. When
 * none of the three knows the certificate it is reported as unrecognised, which is a state the
 * card shows and a task a senior can clear — not a blank space that reads like an answer.
 *
 * No model is asked at any point. If this file cannot explain a certificate, the honest output
 * is "unrecognised — check", and that is what it returns.
 */
import { decodeIso9606, type Decoded } from './iso9606';
import { lookupCert, knowsBody, type CertEntry } from './tables';

export type Explanation = {
  recognised: boolean;
  title: string;
  raw?: string;                 // the designation, kept visible above the decoding
  says: { token: string; label: string; says: string; range?: string }[];
  meaning: string;              // what it says, in one paragraph
  can: string[];                // what the holder can do
  cannot: string[];             // what it does not cover
  fits: string[];               // which of our jobs it satisfies
  trades: string[];
  whoRequires?: string;
  validity?: string;
  verification?: string;
  confirm?: string;             // what a senior must check before this is quoted
  source: 'workspace' | 'shipped' | 'table' | 'decoder' | 'none';
  undecoded?: string[];
};

/** A library row, shipped or workspace-written, in the shape the DB stores. */
export type LibraryRow = {
  body: string; level?: string | null; title: string; meaning: string;
  covers?: string | null; not_covered?: string | null; who_requires?: string | null;
  typical_validity?: string | null; verification_route?: string | null;
  trades?: string[] | null; workspace_id?: string | null;
};

const lines = (s?: string | null) =>
  String(s ?? '')
    .split(/\n|(?<=\.)\s+(?=[A-Z])/)
    .map((x) => x.trim())
    .filter(Boolean);

function fromLibrary(row: LibraryRow, decoded: Decoded | null): Explanation {
  return {
    recognised: true,
    title: row.title,
    raw: decoded?.raw,
    says: decoded?.says ?? [],
    meaning: row.meaning,
    can: lines(row.covers),
    cannot: lines(row.not_covered),
    fits: decoded?.fits ?? [],
    trades: row.trades ?? decoded?.trades ?? [],
    whoRequires: row.who_requires ?? undefined,
    validity: row.typical_validity ?? undefined,
    verification: row.verification_route ?? undefined,
    source: row.workspace_id ? 'workspace' : 'shipped',
    undecoded: decoded?.undecoded,
  };
}

function fromTable(e: CertEntry, decoded: Decoded | null): Explanation {
  return {
    recognised: true,
    title: e.title,
    raw: decoded?.raw,
    says: decoded?.says ?? [],
    meaning: e.meaning,
    // A decoded designation says more about this holder than the scheme paragraph does, so it
    // leads; the scheme text follows it rather than replacing it.
    can: [...(decoded?.can ?? []), ...(decoded ? [] : lines(e.covers))],
    cannot: [...(decoded?.cannot ?? []), ...(decoded ? [] : lines(e.notCovered))],
    fits: decoded?.fits ?? [],
    trades: e.trades,
    whoRequires: e.whoRequires,
    validity: e.validity,
    verification: e.verification,
    confirm: e.confirm,
    source: 'table',
    undecoded: decoded?.undecoded,
  };
}

/**
 * Explain one certificate.
 *
 * `library` is whatever rows were loaded for this body — workspace rows and shipped rows mixed;
 * precedence is applied here so no caller has to remember it.
 */
export function explainCert(input: {
  body?: string | null;
  level?: string | null;
  scope?: string | null;      // the ISO 9606 designation, when there is one
  position?: string | null;
  process?: string | null;
  library?: LibraryRow[];
}): Explanation {
  const body = String(input.body ?? '').toLowerCase().trim();
  const decoded = input.scope || input.position || input.process
    ? decodeIso9606(String(input.scope ?? ''), { position: input.position, process: input.process })
    : null;

  // 1 and 2 — a library row, workspace before shipped, level-specific before scheme-wide.
  const rows = (input.library ?? []).filter((r) => String(r.body).toLowerCase() === body);
  const hay = `${input.level ?? ''} ${input.scope ?? ''}`.trim().toLowerCase();
  const score = (r: LibraryRow) =>
    (r.workspace_id ? 8 : 0) + (r.level && hay.includes(String(r.level).toLowerCase()) ? 4 : 0) + (r.level ? 0 : 1);
  const best = rows.slice().sort((a, b) => score(b) - score(a))[0];
  if (best) return fromLibrary(best, decoded);

  // 3 — the code tables.
  const entry = lookupCert(body, input.level, input.scope);
  if (entry) return fromTable(entry, decoded);

  // A designation we could decode, from a body nobody has written up yet, is still worth all
  // three layers — the decoding is the explanation.
  if (decoded) {
    return {
      recognised: true,
      title: `${decoded.standard} welder qualification`,
      raw: decoded.raw,
      says: decoded.says,
      meaning: `A welder qualification to ${decoded.standard}, which covers ${decoded.material}. Everything it qualifies is in the designation, decoded above.`,
      can: decoded.can,
      cannot: decoded.cannot,
      fits: decoded.fits,
      trades: decoded.trades,
      source: 'decoder',
      undecoded: decoded.undecoded,
    };
  }

  return {
    recognised: false,
    title: input.body ? `${input.body}${input.level ? ` ${input.level}` : ''} — unrecognised` : 'Unrecognised certificate',
    says: [],
    meaning: 'This certificate is not in the library, so nothing about what it covers is being claimed. A senior can add it, and it will then be explained on every card and client pack from that point on.',
    can: [],
    cannot: [],
    fits: [],
    trades: [],
    source: 'none',
  };
}

/** Should this raise an "add to the library" task? */
export const isUnrecognised = (e: Explanation) => !e.recognised;

/** Does the code know this body at all, before any library row is loaded? */
export { knowsBody };

/**
 * One plain-English line per certificate, for the client pack.
 *
 * The client gets what it covers and until when — never the raw designation, which means
 * nothing to a buyer, and never the parts a senior still has to confirm.
 */
export function clientLine(e: Explanation, validUntil?: string | null): string | null {
  if (!e.recognised) return null;
  const until = validUntil ? ` Valid until ${new Date(validUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.` : '';
  const first = e.can[0] ?? e.meaning;
  return `${e.title} — ${first.replace(/\s+$/, '')}${until}`;
}
