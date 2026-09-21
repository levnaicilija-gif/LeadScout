/**
 * A date as a certificate prints it, turned into a real one — or refused, with a reason.
 *
 * WHY THIS EXISTS. `verifications.valid_until` is a Postgres `date`, and the lookup route filled it
 * with `ext.expiry` — the string the model copied off the document, exactly as printed. Postgres then
 * parsed it, in MDY, because that is its default DateStyle:
 *
 *     "17 Jan 2028"  ->  2028-01-17   correct, because a named month cannot be misread
 *     "03.09.2028"   ->  2028-03-09   WRONG. On a European ISO 9606 welding qualification that is
 *                                     3 September 2028, and it was stored as 9 March — six months
 *                                     early, on the column every expiry alert reads.
 *
 * That is the shape of the fault: unambiguous formats survive and ambiguous ones flip in silence, so
 * the column looks healthy and one row in six is wrong. Found 2026-09-21 while investigating item 8.
 *
 * THE RULE, and why it refuses rather than guesses. A wrong expiry is worse than no expiry here: it
 * drives 60/30/7 alerts, and an expired certificate is about to mark someone unavailable for the work
 * it qualifies them for. So a date is returned only when the reading is forced by the text itself:
 *
 *   - already ISO (yyyy-mm-dd)                      taken as it stands
 *   - a named month ("17 Jan 2028", "Jan 17, 2028") unambiguous in any locale
 *   - numeric with one part above 12                the reading is forced ("18.06.2027" can only be
 *                                                   the 18th; "12/25/2027" can only be the 25th)
 *   - numeric, dots, both parts 12 or under         day-first. A dot-separated numeric date is a
 *                                                   European convention and these are European
 *                                                   certificates — FROSIO, ISO 9606, CISRS, WINDA,
 *                                                   electrical_dk. No US document writes 03.09.2028.
 *   - numeric, slashes or dashes, both 12 or under  REFUSED. 05/06/2028 is 5 June to a British issuer
 *                                                   and 6 May to an American one, and AMPP is
 *                                                   American. Nothing in the string settles it, so
 *                                                   nothing is stored and the reason says so.
 *
 * The printed text is never lost: it stays in `documents.extracted.expiry`, so a refusal shows the
 * recruiter what the document says and asks them, rather than inventing a date nobody printed.
 */

export type PrintedDate = {
  /** yyyy-mm-dd, or null when the text does not force one reading. */
  date: string | null;
  /** Plain English: what was read, or why it was refused. Always set. */
  why: string;
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Real calendar day? Catches 31 February and the like, which a string test cannot. */
const realDay = (y: number, m: number, d: number) => {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function printedDate(raw: unknown): PrintedDate {
  const s = String(raw ?? '').trim();
  if (!s) return { date: null, why: 'nothing printed' };

  // Already a real date, or a timestamp starting with one.
  const asIso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (asIso) {
    const [, y, m, d] = asIso.map(Number) as unknown as number[];
    return realDay(y, m, d)
      ? { date: iso(y, m, d), why: `read as ${iso(y, m, d)} — already a date` }
      : { date: null, why: `"${s}" looks like a date but is not a real day` };
  }

  // A named month cannot be misread, in either order.
  const named = s.match(/^(\d{1,2})[\s.\-/]+([a-z]{3,})[\s.\-/,]+(\d{4})$/i)
    ?? s.match(/^([a-z]{3,})[\s.\-/]+(\d{1,2})[\s.\-/,]+(\d{4})$/i);
  if (named) {
    const dayFirst = /^\d/.test(named[1]);
    const d = Number(dayFirst ? named[1] : named[2]);
    const monthWord = String(dayFirst ? named[2] : named[1]).slice(0, 3).toLowerCase();
    const y = Number(named[3]);
    const m = MONTHS[monthWord];
    if (!m) return { date: null, why: `"${s}" — "${dayFirst ? named[2] : named[1]}" is not a month name we know` };
    return realDay(y, m, d)
      ? { date: iso(y, m, d), why: `read as ${iso(y, m, d)} — the month is named, so the order cannot be misread` }
      : { date: null, why: `"${s}" is not a real day` };
  }

  // Numeric, four-digit year last.
  const num = s.match(/^(\d{1,2})([.\-/])(\d{1,2})\2(\d{4})$/);
  if (num) {
    const a = Number(num[1]);
    const sep = num[2];
    const b = Number(num[3]);
    const y = Number(num[4]);
    if (a > 12 && b > 12) return { date: null, why: `"${s}" has no part that can be a month` };
    if (a > 12) {
      return realDay(y, b, a) ? { date: iso(y, b, a), why: `read as ${iso(y, b, a)} — ${a} can only be the day` } : { date: null, why: `"${s}" is not a real day` };
    }
    if (b > 12) {
      return realDay(y, a, b) ? { date: iso(y, a, b), why: `read as ${iso(y, a, b)} — ${b} can only be the day` } : { date: null, why: `"${s}" is not a real day` };
    }
    // Both could be either. Dots settle it; slashes and dashes do not.
    if (sep === '.') {
      return realDay(y, b, a)
        ? { date: iso(y, b, a), why: `read as ${iso(y, b, a)} — dot-separated numeric dates are written day first` }
        : { date: null, why: `"${s}" is not a real day` };
    }
    return { date: null, why: `"${s}" is ambiguous — ${a}/${b} could be either day or month, and the separator does not settle it. The printed text is kept; a recruiter can confirm it.` };
  }

  // Two-digit years and everything else: not worth a guess on a column that drives alerts.
  return { date: null, why: `"${s}" is not in a form that can be read as a date without guessing` };
}
