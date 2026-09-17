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

/** How far through the call the recruiter is. Counts an answer as given when prose OR a verdict is there. */
export const progress = (answers: AnswerRow[]) => {
  const done = answers.filter((a) => (a.answer ?? '').trim() || a.verdict).length;
  return { done, total: answers.length };
};
