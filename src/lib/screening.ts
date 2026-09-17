/**
 * Item 5 part 3: what an answer is allowed to do to a score.
 *
 * Owner's decision, 2026-09-16 — **deterministic verdicts only**. The prose a recruiter types is
 * stored and shown and never interpreted: a model reading "my 6G lapsed in March" and deciding
 * somebody is disqualified is exactly the shape that invents a disqualifier nobody said. Only two
 * kinds of answer carry a machine-readable verdict, and in both cases the verdict is the
 * RECRUITER'S OWN CLICK:
 *
 *   right_to_work   yes / no / unclear      — a "no" is the blocker checkRightToWork already knows
 *   certificate     confirmed / not_confirmed — against the certificate named in `subject`
 *
 * And even then the stored score is never rewritten in place. The call is marked for re-score
 * against its own lead_id/jd_version pairing, and the recruiter re-runs it — so a score always
 * remains the answer to one question asked of one JD version, not something quietly mutated
 * afterwards (owner's sub-decision, same day).
 *
 * The question's `kind` is labelled by the model when the questions are written. A mislabel can
 * only make the wrong control appear; it can never move a score by itself, because a verdict has to
 * be clicked.
 */

export type Verdict = 'yes' | 'no' | 'unclear' | 'confirmed' | 'not_confirmed' | null;
export type Kind = 'right_to_work' | 'certificate' | 'availability' | 'rate' | 'open';

export type AnswerRow = {
  position: number;
  /** Frozen as asked: a JD rewrite regenerates the questions, and this must keep saying what was put to them. */
  question: string;
  /** What a good answer was said to sound like, kept with the question it belonged to. */
  good_answer?: string | null;
  kind: Kind | string;
  subject?: string | null;
  answer?: string | null;
  verdict?: Verdict | string | null;
};

/** Which verdicts a kind may carry at all. Anything else is prose only. */
export const VERDICTS_FOR: Record<string, readonly Verdict[]> = {
  right_to_work: ['yes', 'no', 'unclear'],
  certificate: ['confirmed', 'not_confirmed'],
};

/** Does this kind offer the recruiter a verdict control? */
export const takesVerdict = (kind: string) => kind in VERDICTS_FOR;

/** Is this verdict one this kind may carry? A verdict on an `open` question is ignored, never stored as meaning. */
export const verdictAllowed = (kind: string, verdict: unknown) =>
  !!verdict && (VERDICTS_FOR[kind] ?? []).includes(verdict as Verdict);

const named = (a: AnswerRow) => (a.subject ?? '').trim();

/**
 * Why this call should be re-scored, in a recruiter's words — or null where nothing they marked
 * changes the picture.
 *
 * Deliberately conservative. A missing verdict, an "unclear", a verdict on a kind that may not
 * carry one, and every word of prose all count for nothing here.
 */
export function rescoreReason(answers: AnswerRow[]): string | null {
  const reasons: string[] = [];

  for (const a of answers) {
    if (!verdictAllowed(String(a.kind), a.verdict)) continue;
    if (a.kind === 'right_to_work' && a.verdict === 'no') {
      reasons.push('right to work was refused on the call');
    }
    if (a.kind === 'certificate' && a.verdict === 'confirmed') {
      reasons.push(named(a) ? `${named(a)} was confirmed on the call` : 'a certificate was confirmed on the call');
    }
    if (a.kind === 'certificate' && a.verdict === 'not_confirmed') {
      reasons.push(named(a) ? `${named(a)} could not be confirmed on the call` : 'a certificate could not be confirmed on the call');
    }
  }

  if (reasons.length === 0) return null;
  // One sentence a recruiter reads on the score card, in the order the questions were asked.
  return `${reasons.join('; ')} — score again against this job to take it into account.`;
}

/**
 * The questions every screening call asks, whatever the job (item 5, owner's decision 2026-09-17).
 *
 * Written here rather than asked of the model, for one reason that matters more than tidiness: the
 * `kind` decides which verdict control appears on the call, and right_to_work and certificate are
 * the only two that can mark a re-score. A model labelling a FIXED, unchanging question set would
 * occasionally mislabel one, and the control would silently disappear — no error, no warning, just a
 * question a recruiter can no longer mark. Deterministic here, the label is a fact.
 *
 * It also frees the model's budget. It writes only what it alone can write — the questions that come
 * out of this candidate's own score — and these seven cost it nothing.
 *
 * Right to work is NOT here: both routes already inject it first, because a "no" ends the call and
 * it must never be the eighth question.
 */
export const STANDARD_QUESTIONS: { q: string; good_answer: string; kind: Kind; subject: string }[] = [
  {
    q: 'Which certificates do you hold for this work, and when does each expire?',
    good_answer: 'Names them from memory with expiry dates, and can send the certificates today.',
    kind: 'certificate', subject: '',
  },
  {
    q: 'What rotation have you worked, and what would you take now?',
    good_answer: 'Names real rotations worked — 2:2, 4:4 — and is straight about what they will not do.',
    kind: 'open', subject: '',
  },
  {
    q: 'Offshore medical and safety training — BOSIET, GWO, VCA: what is valid, and until when?',
    good_answer: 'Dates given; where one has lapsed, willing to sit the course before mobilisation.',
    kind: 'open', subject: '',
  },
  {
    q: 'English on site — could you follow a toolbox talk and a permit to work?',
    good_answer: 'Answers this question in English, without help.',
    kind: 'open', subject: '',
  },
  {
    q: 'What is your earliest start, and what notice do you owe anyone?',
    good_answer: 'A date they can actually make, and a notice period they state plainly.',
    kind: 'availability', subject: '',
  },
  {
    q: 'What rate are you expecting, all in?',
    good_answer: 'A figure that is realistic for the country, and they say whether it is all-in or margin-only.',
    kind: 'rate', subject: '',
  },
  {
    q: 'Is there any client you cannot work for — a non-compete, or somewhere you left badly?',
    good_answer: 'A straight answer. Whatever it is, the recruiter hears it now rather than from the client.',
    kind: 'open', subject: '',
  },
];

/** The ground each standard question covers, so a model-written duplicate can be dropped. */
/**
 * Each pattern matches the SHAPE of its standard question, never its subject matter.
 *
 * The first cut keyed on subject — `certificat|expir|iso 9606|frosio|cswip` — and swallowed
 * "Which positions are on your ISO 9606, and what thickness have you welded to ISO 5817 level B?",
 * which is precisely the doubtful-fit probe the model is now asked to write (2026-09-17). A standard
 * question takes inventory ("which certificates do you hold, when does each expire"); a fit probe
 * names one standard and asks for specifics. Only the first is a duplicate, and a pattern that
 * cannot tell them apart deletes the more useful question of the two — silently, since a dropped
 * question leaves no trace on the call.
 *
 * When in doubt these must UNDER-match: a duplicate costs a recruiter thirty seconds, while a
 * swallowed probe costs the thing that would have come out on the call.
 */
const COVERS: RegExp[] = [
  /(which|what) certificates|certificates do you hold|when does each expire|certificates.*and.*expire/i,
  /what rotation|which rotation|rotation have you worked|shift pattern/i,
  // Shape, not subject: the standard question asks what is VALID and UNTIL WHEN. Keying on the
  // ticket names ate "The CV says offshore medical — which clinic, and what did it cover?", which is
  // a specifics probe (2026-09-17) — the same mistake as the certificate row, left in one place.
  /what is valid,? and until when|which .*(are|is) valid|valid,? and until when|still valid/i,
  /english on site|toolbox talk|permit to work|follow a toolbox/i,
  /earliest start|when could you start|notice do you owe|notice period/i,
  /what rate|rate are you expecting|day rate|hourly rate|all.?in rate/i,
  /non.?compete|cannot work for|client you cannot|left badly/i,
];

/**
 * The model's questions, then the seven — with any model-written duplicate of the same ground removed.
 *
 * The model is asked for score-derived questions only, but it sometimes reaches for a standard one
 * anyway. Dropping its version rather than the fixed one keeps the certain `kind`.
 */
export function withStandardQuestions<T extends { q: string }>(fromModel: T[]): (T | typeof STANDARD_QUESTIONS[number])[] {
  const kept = fromModel.filter((m) => !COVERS.some((re) => re.test(m.q)));
  return [...kept, ...STANDARD_QUESTIONS];
}

/** A finished call, as the score card needs to know about it. */
export type CallFlag = {
  candidate_id: string;
  lead_id: string | null;
  jd_version: number | null;
  needs_rescore: boolean | null;
  rescore_reason: string | null;
  finished_at: string | null;
};

/**
 * Does a call ask for this candidate to be scored again against THIS job at THIS version?
 *
 * Matched on lead_id AND jd_version together, never the lead alone (owner's decision, 2026-09-17).
 * A JD rewrite bumps jd_version and regenerates the questions, so a call answered against version 2
 * says nothing about version 3 — the questions put to the candidate were different ones. A flag that
 * survived the rewrite would be stale and still displaying, which is precisely what keying answers
 * to a version exists to prevent.
 *
 * Only a FINISHED call counts: needs_rescore is worked out when the call is closed, so one still in
 * progress has settled nothing.
 */
export function rescoreFor(
  calls: CallFlag[],
  candidateId: string,
  leadId: string,
  jdVersion: number | null,
): string | null {
  const mine = calls
    .filter((c) => c.candidate_id === candidateId && c.lead_id === leadId && c.finished_at && c.needs_rescore)
    // A null version matches only a null version: "no JD version" is not a wildcard.
    .filter((c) => (c.jd_version ?? null) === (jdVersion ?? null))
    .sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)));
  return mine[0]?.rescore_reason ?? null;
}

/** How far through the call the recruiter is. Counts an answer as given when prose OR a verdict is there. */
export const progress = (answers: AnswerRow[]) => {
  const done = answers.filter((a) => (a.answer ?? '').trim() || a.verdict).length;
  return { done, total: answers.length };
};
