import { matchName, normName, type Person } from './name-match';

/**
 * Is a dropped CV someone already in the pool? (item 24)
 *
 * The rule proven on the WindEurope imports (src/lib/attendee-import.ts#personKey): a name alone never makes two records
 * one person — 932 names in the Annual Event 2026 list also appeared in Copenhagen at a different company. There the
 * second field was the company; for a candidate it is what a CV prints about the person: email, phone, date of birth.
 *
 *   exact name + a second field that agrees         → ask: "likely the same person"
 *   near name  + a second field that agrees         → ask: an initial or a dropped middle name, and the email agrees
 *   exact name, nothing on one side to compare      → ask, and say the match is on the name only
 *   exact name, and every field both sides have differs → create: a different person with the same name, said so
 *   near name with nothing agreeing, or no name match → create
 *
 * Nothing is merged or attached here; "ask" puts the choice in front of the recruiter with the reason. matchName supplies
 * exact and near exactly as Verify uses them, so the two never disagree about what a name match is.
 */
export type CandidateIdentity = Person & { email?: string | null; phone?: string | null; dob?: string | null };
export type Incoming = { full_name?: string | null; email?: string | null; phone?: string | null; dob?: string | null };
export type DuplicateMatch<T extends CandidateIdentity> = { candidate: T; strength: 'likely' | 'name_only'; why: string };
export type Judgement<T extends CandidateIdentity> =
  | { verdict: 'create'; why: string; namesakes: T[] }
  | { verdict: 'ask'; matches: DuplicateMatch<T>[] };

const email = (s?: string | null) => (s ?? '').trim().toLowerCase() || null;
/** The last nine digits: "+47 912 34 567" and "0047 91234567" are one number; a date range's eight digits are not one. */
const phone = (s?: string | null) => { const d = (s ?? '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : null; };
const dob = (s?: string | null) => (s ?? '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;

type Compared = { agree: string[]; differ: string[] };
function compare(a: Incoming, b: CandidateIdentity): Compared {
  const out: Compared = { agree: [], differ: [] };
  const pairs: [string, string | null, string | null][] = [
    ['email', email(a.email), email(b.email)],
    ['phone', phone(a.phone), phone(b.phone)],
    ['date of birth', dob(a.dob), dob(b.dob)],
  ];
  for (const [field, x, y] of pairs) {
    if (!x || !y) continue;
    (x === y ? out.agree : out.differ).push(field);
  }
  return out;
}

export function judgeDuplicate<T extends CandidateIdentity>(pool: T[], incoming: Incoming): Judgement<T> {
  if (!normName(incoming.full_name)) return { verdict: 'create', why: 'the CV prints no name to compare', namesakes: [] };
  const found: DuplicateMatch<T>[] = [];
  const namesakes: T[] = [];
  for (const m of matchName(pool, incoming.full_name)) {
    const c = compare(incoming, m.candidate);
    if (c.agree.length) {
      found.push({ candidate: m.candidate, strength: 'likely', why: `${m.why}, and the ${c.agree.join(' and ')} agree${c.agree.length === 1 ? 's' : ''}` });
    } else if (m.kind === 'exact' && c.differ.length === 0) {
      found.push({ candidate: m.candidate, strength: 'name_only', why: `${m.why}; neither has an email, phone or date of birth the other can be compared with — the match is on the name only` });
    } else if (m.kind === 'exact') {
      namesakes.push(m.candidate);
    }
  }
  if (found.length) return { verdict: 'ask', matches: found.sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'likely' ? -1 : 1)) };
  return {
    verdict: 'create',
    why: namesakes.length
      ? `${namesakes.length} candidate${namesakes.length === 1 ? ' has' : 's have'} the same name, but every email, phone or date of birth both records hold differs — a different person`
      : 'nobody in the pool has this name',
    namesakes,
  };
}
