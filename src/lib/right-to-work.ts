import { EU27, norm } from './geo';

/**
 * Can this person legally start on that site?
 *
 * A gate, not a preference. A welder without an EU passport cannot start in Denmark however
 * good the CV, and an EU passport alone is not enough for the UK — since 2021 an EU national
 * needs settled or pre-settled status or a work visa, and "they'll sort it out" has cost
 * agencies whole placements. So it is a blocker in scoring, and the reason is written in words
 * a recruiter can repeat to a client.
 *
 * Not knowing is its own answer. `unknown` is never treated as a pass: it means ask, and it is
 * the first screening question.
 */
export type Verdict = 'ok' | 'blocked' | 'unknown';

export type Rtw = {
  nationality?: string | null;
  eu_passport?: boolean | null;
  uk_right_to_work?: boolean | null;
  uk_right_to_work_basis?: string | null;
};

/** EEA for these purposes: the EU 27 plus Norway, Iceland and Liechtenstein. */
const EEA = [...EU27, 'NO', 'IS', 'LI'] as readonly string[];

export const isEea = (cc?: string | null) => EEA.includes(norm(cc));
export const isUk = (cc?: string | null) => ['GB', 'UK'].includes(norm(cc));

/** Does holding this nationality carry an EU/EEA passport? */
export const nationalityGivesEu = (cc?: string | null) => (cc ? isEea(cc) : undefined);

export type RtwCheck = {
  verdict: Verdict;
  /** One line for the score card, in the recruiter's own language. */
  rule: string;
  /** What is missing, phrased as the thing to go and get. */
  blocker?: string;
  /** The question to ask first on the call. */
  question?: string;
};

/**
 * @param jobCountry the country the WORK is in — the lead's country, not the candidate's.
 */
export function checkRightToWork(jobCountry: string | null | undefined, c: Rtw): RtwCheck {
  const cc = norm(jobCountry);

  if (isUk(cc)) {
    const rule = 'UK site: a UK passport, or an EU national with settled or pre-settled status or a work visa. An EU passport alone is not enough.';
    if (c.uk_right_to_work === true) {
      return { verdict: 'ok', rule: `${rule} Confirmed${c.uk_right_to_work_basis ? ` — ${c.uk_right_to_work_basis.replace(/_/g, ' ')}` : ''}.` };
    }
    if (norm(c.nationality) === 'GB') return { verdict: 'ok', rule: `${rule} British national.` };
    if (c.uk_right_to_work === false) {
      return { verdict: 'blocked', rule, blocker: 'No UK right to work — cannot be put forward for a UK site until settled status or a visa is in place.', question: 'Do you have UK settled or pre-settled status, or a UK work visa? Which, and can you share the share code?' };
    }
    return {
      verdict: 'unknown', rule,
      blocker: 'UK right to work not confirmed — an EU passport does not cover a UK site.',
      question: 'Do you have UK settled or pre-settled status, or a UK work visa? Which, and can you share the share code?',
    };
  }

  if (isEea(cc)) {
    const rule = `${cc} site: an EU/EEA passport is required.`;
    if (c.eu_passport === true) return { verdict: 'ok', rule: `${rule} Confirmed.` };
    if (nationalityGivesEu(c.nationality) === true) return { verdict: 'ok', rule: `${rule} ${c.nationality} national.` };
    if (c.eu_passport === false || nationalityGivesEu(c.nationality) === false) {
      return { verdict: 'blocked', rule, blocker: `No EU/EEA passport — cannot work in ${cc} without a work permit the client would have to sponsor.`, question: 'Do you hold an EU or EEA passport in hand today? Which country issued it, and when does it expire?' };
    }
    return {
      verdict: 'unknown', rule,
      blocker: 'EU/EEA passport not confirmed.',
      question: 'Do you hold an EU or EEA passport in hand today? Which country issued it, and when does it expire?',
    };
  }

  return {
    verdict: 'unknown',
    rule: cc ? `Right to work in ${cc} is outside the EU/EEA and UK rules — check what the client requires.` : 'The job has no country on it yet, so right to work cannot be checked.',
  };
}

/**
 * Where to look for candidates for THIS job.
 *
 * The countries follow the work, not habit: an EU job draws on the EU and Norway, a UK job looks
 * in the UK first and then the EU. Serbia was the old default and is wrong for both — a Serbian
 * welder needs a permit no client will sponsor for a six-week scope.
 */
export function searchCountriesFor(jobCountry: string | null | undefined, workspaceDefaults: string[]): string[] {
  const cc = norm(jobCountry);
  const pool = workspaceDefaults.filter((x) => isEea(x));
  if (isUk(cc)) return ['GB', ...pool];
  if (isEea(cc)) return [...new Set([cc, ...pool])].filter(isEea);
  return pool;
}
