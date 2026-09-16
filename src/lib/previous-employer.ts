import { canonCompany, sameCompany } from '@/lib/company-identity';

/**
 * Legal forms canonCompany does not know, stripped HERE and nowhere else (owner's decision,
 * 2026-09-16).
 *
 * canonCompany's list has no SC (Societate Comercială, a Romanian prefix) and no SRL, so on the
 * real pool "SC Vard Brăila SA" read as `sc vard braila` against a company row's `vard braila`,
 * and "Saver Saldature" never matched "Saver Saldature SRL" — three of the four employments on the
 * one real CV we hold. Adding them to canonCompany would fix it everywhere and would probably be
 * right, but that function decides whether two company ROWS are one company, and a wrong merge
 * moves another company's leads and contacts onto the survivor with no way back. So the wider
 * change stays a measured decision of its own, and the cost of being wrong here is one irrelevant
 * screening question.
 *
 * Stripped from BOTH names: the CV carries the prefix ("SC Vard Brăila SA") and the company row
 * carries the suffix ("Saver Saldature SRL"), so a one-sided strip fixes only half the cases.
 */
const EXTRA_LEGAL = /(?<![\p{L}\p{N}])(srl|s r l|sro|s r o|sp z o o|uab)(?![\p{L}\p{N}])/giu;

/**
 * "SC" is only dropped when what remains is still a name of its own — two words or more.
 *
 * There is no way to tell the Romanian prefix from a brand by looking at the string: "SC Vard
 * Brăila" is Societate Comercială Vard Brăila, and "SC Johnson" is a company called SC Johnson.
 * A bare strip took the brand with it and would have matched SC Johnson to any firm called
 * Johnson. So this is a heuristic, stated as one: a single remaining word is too likely to BE the
 * brand, and the badge would rather miss a Romanian match than invent one. "Zoo", "Sia", "SPA" and
 * "OÜ" were speculative additions of mine and are gone — a Romanian and Italian pool needs none.
 */
const stripSc = (canon: string) => {
  const rest = canon.replace(/^sc (?=[\p{L}\p{N}])/iu, '');
  return rest !== canon && rest.split(' ').filter(Boolean).length >= 2 ? rest : canon;
};

/** canonCompany, then the forms it does not know — for comparison only, never for storage. */
const canonForEmployer = (name: string) =>
  stripSc(canonCompany(name)).replace(EXTRA_LEGAL, ' ').replace(/\s+/g, ' ').trim();

/**
 * Has this candidate worked for the company behind this lead before?
 *
 * Item 11 asked for the CV's "employers, yards and sites" against "the lead company and its known
 * sites". Neither half of that exists: the CV parser is told to DESCRIBE a named asset rather than
 * name it ("Jotun A" becomes "offshore platform, Norwegian North Sea") so that a client PDF can
 * never identify the person by where they worked, and no table anywhere holds a company's sites.
 * So this compares employer names and says exactly that — "worked for this employer before", never
 * "knows the site" (owner's decision, 2026-09-16). Site-level matching needs a company_sites table
 * and a new, internal-only site field on the CV profile; it is a future item, not this one.
 *
 * The comparison is `sameCompany`, the same cautious rule the rest of the codebase merges on:
 * in practice only its first branch can fire here, because an employer printed on a CV has no
 * domain to share. "Vard Brăila SA" matches "VARD Braila", "Hitachi Energy Norway" does not match
 * "Hitachi Energy Denmark", and a near-miss is not a match at all.
 *
 * Nothing here is inferred. Every field shown comes off the CV as written.
 */

export type EmployerMatch = {
  /** The employer exactly as the CV prints it. */
  employer: string;
  /** The years exactly as the CV prints them — "2015-2017", "June 2020 – August 2024". */
  years: string;
  /** Still there by the CV's own account, so a notice period or a non-compete may be in the way. */
  current: boolean;
  /** Why the two names were judged the same, from sameCompany. */
  why: string;
};

export type PreviousEmployer = {
  matches: EmployerMatch[];
  /** The one the card shows: a current employment outranks a past one, then the first listed. */
  headline: EmployerMatch;
  /** Badge wording. Deliberately about the employer, never the site. */
  label: string;
  tone: 'ok' | 'warn';
  /** The single screening question this case earns. */
  question: string;
  goodAnswer: string;
};

/** An employment the CV leaves open: "2024 – present", "2024 –", "since 2024". */
const OPEN_END = /(present|current|now|ongoing|to date|pågår|nåværende)\s*$|[-–—]\s*$|^\s*(since|from|sinds|desde|depuis)\b/i;

const isCurrent = (years: string, currentEmployer: string | null | undefined, employer: string) => {
  const theirs = canonForEmployer(currentEmployer ?? '');
  if (theirs && theirs === canonForEmployer(employer)) return true;
  return OPEN_END.test((years ?? '').trim());
};

/**
 * @param profile   the candidate's stored CV reading (candidates.profile) — read raw, never the
 *                  anonymised copy, which strips every employer before the model sees it.
 * @param company   the company behind the lead or the job post.
 * @param currentEmployer  candidates.current_employer, when a contract has set it.
 */
export function previousEmployer(
  profile: { projects?: { employer?: string | null; years?: string | null }[] } | null | undefined,
  company: { name?: string | null; domain?: string | null } | null | undefined,
  currentEmployer?: string | null,
): PreviousEmployer | null {
  const name = (company?.name ?? '').trim();
  const theirName = canonForEmployer(name);
  if (!name || !theirName) return null;

  const matches: EmployerMatch[] = [];
  for (const p of profile?.projects ?? []) {
    const employer = (p?.employer ?? '').trim();
    if (!employer) continue;
    // Compared on the stripped forms, so the badge is not decided by whether a CV wrote "SRL".
    // sameCompany still makes the judgement, and still refuses a near miss.
    const mine = canonForEmployer(employer);
    if (!mine) continue;
    const verdict = sameCompany({ name: mine }, { name: theirName, domain: company?.domain ?? null });
    if (!verdict.same) continue;
    const years = (p?.years ?? '').trim();
    matches.push({ employer, years, current: isCurrent(years, currentEmployer, employer), why: verdict.why });
  }
  if (!matches.length) return null;

  const headline = matches.find((m) => m.current) ?? matches[0];
  const when = headline.years ? ` (${headline.years})` : '';

  // Two different situations, and a recruiter must be able to tell them apart at a glance: someone
  // who knows the client is an asset, someone still on their books may be unable to come at all.
  return headline.current
    ? {
        matches, headline, tone: 'warn',
        label: `Works for this employer now — ask${when}`,
        question: `Your CV has you at ${headline.employer}${when}. Do you have a notice period, a non-compete or anything else that would stop you working for them through us?`,
        goodAnswer: 'A clear notice period they can state, and no clause preventing the move.',
      }
    : {
        matches, headline, tone: 'ok',
        label: `Worked for this employer before${when}`,
        question: `You worked at ${headline.employer}${when}. How did that end, and is there any reason they would not take you back?`,
        goodAnswer: 'Left on their own terms, would be taken back, and can name who they worked under.',
      };
}
