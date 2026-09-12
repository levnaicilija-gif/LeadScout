/**
 * Matching a name on a document to a person in the pool.
 *
 * Two answers, never blurred into one. An `exact` match is acted on: the document attaches by
 * itself. A `near` match is only ever offered — "Attach to RFBT-P-0004?" — because the cases
 * that land here are the ones where being wrong is expensive: "M. Marcu" and "Marian Marcu" are
 * probably the same man, and "Paul Daniel Pascale" and "Paul Pascale" probably are too, but
 * attaching a welder's certificate to the wrong welder puts an unqualified man on a plane.
 *
 * The reason is returned with the match so the offer can say why it is being made. A recruiter
 * accepting "same surname, first initial agrees" is making a decision; a recruiter accepting
 * "Attach?" is guessing along with us.
 */

export type Person = { id: string; reference_code: string; full_name?: string | null };
export type Match<T extends Person = Person> = { candidate: T; kind: 'exact' | 'near'; why: string };

/** Lower case, accents removed, punctuation dropped — "PEPLIŃSKI, Szymon" → "peplinski szymon". */
export const normName = (n?: string | null) =>
  (n ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const words = (n?: string | null) => normName(n).split(' ').filter(Boolean);

/** An initial standing for a name: "m" for "marian". One letter only — "ma" is not an initial. */
const isInitial = (w: string) => w.length === 1;

/**
 * Every candidate this name could be, best first.
 *
 * Exact means: the same set of name words, or first and last both present in either order —
 * the ordering varies by country and half these documents put the surname first.
 */
export function matchName<T extends Person>(known: T[], name?: string | null): Match<T>[] {
  const k = words(name);
  if (k.length < 2) return [];
  const first = k[0];
  const last = k[k.length - 1];
  const out: Match<T>[] = [];

  for (const c of known) {
    const cw = words(c.full_name);
    if (cw.length < 1) continue;
    const cFirst = cw[0];
    const cLast = cw[cw.length - 1];

    if (normName(c.full_name) === normName(name)) { out.push({ candidate: c, kind: 'exact', why: 'the same name, spelled the same way' }); continue; }
    if (cw.includes(first) && cw.includes(last) && cw.length >= 2) { out.push({ candidate: c, kind: 'exact', why: 'first and last name both present, in either order' }); continue; }

    // --- near. Each of these is a real pattern in the documents, not a fuzzy score.
    const sharesSurname = cw.includes(last) || k.includes(cLast);

    // "M. Marcu" on file, "Marian Marcu" on the document — or the other way round.
    if (sharesSurname && (isInitial(cFirst) || isInitial(first)) && (cFirst[0] === first[0])) {
      out.push({ candidate: c, kind: 'near', why: `same surname, and the first name is an initial on one of them (${cFirst[0].toUpperCase()}.)` });
      continue;
    }
    // "Paul Daniel Pascale" on the document, "Paul Pascale" on file — a middle name dropped.
    if (sharesSurname && cFirst === first && cw.length !== k.length) {
      out.push({ candidate: c, kind: 'near', why: 'same first and last name; one of them carries a middle name the other does not' });
      continue;
    }
    // Surname alone, nothing else agreeing. Weak, and said to be weak.
    if (sharesSurname && last.length > 3) {
      out.push({ candidate: c, kind: 'near', why: `only the surname matches (${last}) — check before attaching` });
    }
  }

  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'exact' ? -1 : 1));
}

/** The one candidate a document may attach to without being asked, if there is exactly one. */
export function autoMatch<T extends Person>(known: T[], name?: string | null): T | undefined {
  const exact = matchName(known, name).filter((m) => m.kind === 'exact');
  return exact.length === 1 ? exact[0].candidate : undefined;
}
