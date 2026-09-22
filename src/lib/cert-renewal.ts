import { CERT_TABLE } from '@/lib/certs/tables';

/**
 * The message a recruiter sends a candidate whose certificate is running out — drafted, never sent.
 *
 * WHY THIS FILE EXISTS. Today has carried an expiring-certificate item since item 8's first pass, and
 * its sub-line read "Renewal message drafted". Nothing drafted one. The only occurrence of the word
 * "renewal" anywhere in src/ was that string: no function, no template, no stored text, nothing on
 * any screen. A line telling a recruiter that work has been done for them, where none had, is the
 * same class of fault as a verified state with no register behind it — and it is the sixth of that
 * shape found on 2026-09-21/22.
 *
 * DRAFTED, NEVER SENT, like every other message this app writes: the issuer verification email
 * (verify/routes.ts#issuerEmail), the lead approach, the prepared searches. Nothing leaves except
 * through /api/outreach, by a recruiter, to an address attached to a contact — and a candidate is not
 * a contact, so this one is text to copy, not a thing with a send button.
 *
 * What it will not do: invent a renewal route. Where the certificate library knows how a body renews
 * (cert_library.validity, seeded from certs/tables.ts) the draft says so in the issuer's own words;
 * where it does not, it asks the candidate rather than guessing at a process that may not exist.
 */

export type Renewal = { subject: string; body: string; basis: string };

/** "18 June 2027" — the way a date is read aloud on a phone call. */
const spoken = (iso: string) => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** Whole days from today to the expiry, negative once it has gone. */
export const daysTo = (validUntil: string, now = new Date()) =>
  Math.round((Date.parse(`${validUntil}T00:00:00Z`) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86400000);

/**
 * The alert thresholds, and the one it has just crossed.
 *
 * 60 / 30 / 7 from the queue item, measured against verifications.valid_until — the only normalised
 * date this codebase has for a certificate. documents.extracted.expiry is the text as PRINTED
 * ("18.06.2027", "17 Jan 2028") and is deliberately not used: handing it to Postgres as a date is
 * what stored a European 03.09.2028 as 9 March, six months early, until dab0828.
 *
 * Returns the tightest threshold the certificate is inside, so a certificate 5 days out is a 7-day
 * alert and not three separate ones.
 */
export const THRESHOLDS = [7, 30, 60] as const;
export type Threshold = (typeof THRESHOLDS)[number];

export function thresholdFor(validUntil: string | null | undefined, now = new Date()): Threshold | 'expired' | null {
  if (!validUntil) return null;
  const d = daysTo(validUntil, now);
  if (d < 0) return 'expired';
  return THRESHOLDS.find((t) => d <= t) ?? null;
}

/** What the certificate library says about how this body renews, in its own words, or null. */
export function validityNote(certBody: string | null | undefined, level?: string | null): string | null {
  if (!certBody) return null;
  const rows = CERT_TABLE.filter((e: any) => String(e.body).toLowerCase() === String(certBody).toLowerCase());
  if (!rows.length) return null;
  const exact = level ? rows.find((e: any) => String(e.level ?? '').toLowerCase() === String(level).toLowerCase()) : null;
  const row: any = exact ?? rows[0];
  return row?.validity ? String(row.validity) : null;
}

/**
 * The draft itself.
 *
 * @param certBody   frosio | cswip | pcn … as stored on the document
 * @param validUntil yyyy-mm-dd from verifications.valid_until — a real date, never printed text
 */
export function renewalDraft(opts: {
  candidateName?: string | null;
  reference?: string | null;
  certBody?: string | null;
  level?: string | null;
  number?: string | null;
  validUntil: string;
  agency: string;
  now?: Date;
}): Renewal {
  const { candidateName, reference, certBody, level, number, validUntil, agency } = opts;
  const days = daysTo(validUntil, opts.now ?? new Date());
  const gone = days < 0;
  const cert = [certBody ? String(certBody).toUpperCase() : 'certificate', level].filter(Boolean).join(' ');
  const who = candidateName?.trim() || reference || 'there';
  const validity = validityNote(certBody, level);

  const when = gone
    ? `expired on ${spoken(validUntil)}`
    : days === 0
      ? `expires today, ${spoken(validUntil)}`
      : `expires on ${spoken(validUntil)} — ${days} day${days === 1 ? '' : 's'} from now`;

  return {
    subject: gone
      ? `Your ${cert} has expired — we cannot put you forward until it is renewed`
      : `Your ${cert} expires on ${spoken(validUntil)}`,
    body: `Hello ${who},

Your ${cert}${number ? ` (number ${number})` : ''} ${when}.

${gone
  ? 'Until it is renewed we cannot put you forward for work that requires it, and a client who finds an expired certificate on site sends people home. Please book the renewal and send us the new certificate as soon as you have it.'
  : 'Please book the renewal in good time and send us the new certificate when you have it — we can then keep putting you forward without a gap.'}
${validity ? `\nWhat the issuer says about validity: ${validity}\n` : '\nIf you are not sure what the renewal involves, tell us and we will find out with the issuing body.\n'}
Send the new certificate to this address and we will check it against the issuer's register straight away.

Kind regards,
${agency}`,
    basis: validity
      ? `valid_until ${validUntil} from the issuer check, and the certificate library's own validity note`
      : `valid_until ${validUntil} from the issuer check — the library records no renewal terms for this body, so the draft asks rather than states`,
  };
}
