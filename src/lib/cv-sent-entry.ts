/**
 * How one `sends` row reads — on a candidate's page, in the list's "CV sent to" column and in the pool's search.
 *
 * `sends` holds two kinds of row. A CV logged as sent (`api/candidates/[id]/sends`, item 24) always carries sent_at and
 * sent_by. A pack attached to a lead ("Send to this lead", `api/leads/send-pack`) is prepared, not sent: its sent_at is null
 * by design, because nothing leaves LeadScout except through /api/outreach, and until 2026-09-15 it recorded nobody. Item 24
 * read every row as a CV sent and passed that null to `new Date()`, which is 1 January 1970: candidate #9's McDermott pack
 * (prepared 2026-09-10, before item 24) read "01/01/1970 · logged by —", and the search "sent to mcdermott" found them.
 *
 * A null or unreadable date is "date not recorded", never a date; a pack is "pack prepared", never "sent to".
 */
export type SendKind = 'sent' | 'prepared';

// No CV in this app was sent before 2000; an earlier instant is a null that became a date somewhere on the way.
const EARLIEST = Date.UTC(2000, 0, 1);

const when = (sentAt: string | null | undefined): number | null => {
  if (!sentAt) return null;
  const t = Date.parse(sentAt);
  return Number.isNaN(t) || t < EARLIEST ? null : t;
};

export function sendKind(sentAt: string | null | undefined): SendKind {
  return when(sentAt) === null ? 'prepared' : 'sent';
}

export function sendDateLabel(sentAt: string | null | undefined): string {
  const t = when(sentAt);
  return t === null ? 'date not recorded' : new Date(t).toLocaleDateString('en-GB');
}

/** The words the pool's boolean search reads for one row. */
export function sendSearchText(client: string, sentAt: string | null | undefined): string {
  return sendKind(sentAt) === 'sent' ? `sent to ${client}` : `pack for ${client}`;
}
