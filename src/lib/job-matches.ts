import { scoreAgainstJob } from '@/lib/ai/documents';
import { checkRightToWork, type Rtw } from '@/lib/right-to-work';
import type { Shortlisted } from '@/lib/job-shortlist';

/**
 * Score a candidate against a shortlist of jobs — concurrently, inside the day's budget.
 *
 * The shortlist (job-shortlist.ts) has already thrown away everything implausible for nothing. This
 * spends real money on what is left: claude-sonnet-5 at EUR 0.01535 and 12.8 s a job, measured. Twelve
 * jobs is about EUR 0.18 — and over two minutes if they are run one after another, which is why they
 * are not.
 *
 * WHAT A JOB IS MADE OF, and why this file cares. scoreAgainstJob asks for "one reason per requirement
 * the job actually states", which assumes the job states some. A won-work lead has a written job
 * description; an open POSTING, as things stand on 2026-09-22, has a role title of about 37 characters
 * and nothing else — 0 of 55 carry a stored description, 2 name a certificate, none state a rotation
 * or a contract type. Scoring a CV against a title alone would ask the model to judge a match from
 * almost nothing, and the failure mode is not a bad score: it is INVENTED REQUIREMENTS, which is the
 * one thing this codebase refuses everywhere else.
 *
 * So the text is resolved before anything is spent, and every match says where its job text came from.
 * A caller that cannot supply more than a title gets `from: 'title'` on the result and can decide
 * whether that is worth showing — the decision is surfaced, not buried.
 */

export type JobText = { text: string; from: 'description' | 'fetched' | 'title'; chars: number };

export type Match = {
  jobId: string;
  score: number;
  fits: string[];
  missing: string[];
  blockers: string[];
  reasons: { requirement: string; met: boolean; evidence: string }[];
  /** Where the job text came from — 'title' means there was barely anything to judge. */
  from: JobText['from'];
  chars: number;
};

export type MatchRun = {
  matches: Match[];
  /** Jobs that were shortlisted but not scored, and why: budget, a failed call, no text at all. */
  skipped: { jobId: string; why: string }[];
  spentEur: number;
  /** Wall clock for the whole run, which is the number that meets the 60 s component abort. */
  ms: number;
  /** How many ran at once. */
  concurrency: number;
};

/** Everything the scorer needs about the person, in the shape scoreAgainstJob already wants. */
export type MatchCandidate = {
  /** The ANONYMISED profile — anonymize() strips employers before the prompt sees it. */
  anon: object;
  /** Confirmed certificates, passed as the extra signal they are. */
  verified: object[];
  rightToWork?: Rtw;
};

/**
 * Run `fn` over `items`, `size` at a time, keeping results in the order they were given.
 *
 * The same small pool classify-sources uses. Concurrency here is not an optimisation: twelve
 * comparisons at 12.8 s each is 154 s sequentially, and every recruiter component aborts at 60 s.
 */
async function pool<T, R>(items: T[], size: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  }));
  return out;
}

/**
 * Score the shortlist.
 *
 * @param jobText  resolves a job's text. Kept as a callback so this file needs no database and no
 *                 network of its own, and so a caller can choose whether to re-read an advert page.
 * @param canAfford asked before EVERY call, not once at the start: the pool spends concurrently, so a
 *                 single check up front would let `concurrency` calls through after the cap was hit.
 */
export async function scoreShortlist(
  candidate: MatchCandidate,
  shortlist: Shortlisted[],
  opts: {
    jobText: (s: Shortlisted) => Promise<JobText | null>;
    canAfford?: () => boolean;
    concurrency?: number;
    /**
     * The comparison itself. Injected for the same reason jobText is: this file's job is the
     * ORCHESTRATION — what is skipped, what is spent, what order the answers come back in — and every
     * one of those is worth testing without a claude-sonnet-5 call and EUR 0.015 per assertion.
     * Defaults to the real one, so a caller that does not care gets the real behaviour.
     */
    score?: typeof scoreAgainstJob;
    /** Only used to add the right-to-work blocker, exactly as scoreWithRightToWork does. */
    jobCountryOf?: (s: Shortlisted) => string | null | undefined;
  },
): Promise<MatchRun> {
  const t0 = Date.now();
  // Four at a time. Enough that twelve jobs finish well inside a minute at the measured 12.8 s each,
  // and few enough that a burst of Sonnet calls does not become the outbound-connection problem this
  // machine already has with anything that opens many sockets at once.
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const skipped: { jobId: string; why: string }[] = [];
  let spentEur = 0;

  const results = await pool(shortlist, concurrency, async (s) => {
    if (opts.canAfford && !opts.canAfford()) { skipped.push({ jobId: s.job.id, why: 'the daily budget was reached' }); return null; }
    let text: JobText | null = null;
    try {
      text = await opts.jobText(s);
    } catch (e: any) {
      skipped.push({ jobId: s.job.id, why: `the job text could not be read: ${String(e?.message ?? e).slice(0, 80)}` });
      return null;
    }
    if (!text || !text.text.trim()) { skipped.push({ jobId: s.job.id, why: 'the job states no text to score against' }); return null; }

    try {
      const scored = await (opts.score ?? scoreAgainstJob)(candidate.anon, candidate.verified, text.text);
      const country = opts.jobCountryOf?.(s) ?? s.job.country ?? null;
      const rtw = checkRightToWork(country, candidate.rightToWork ?? {});
      // The same rule scoreWithRightToWork applies: a right-to-work verdict is a BLOCKER, not a
      // score adjustment, and it is decided in code rather than by the model.
      const blockers = rtw.verdict === 'ok' ? scored.blockers : [rtw.blocker ?? rtw.rule, ...scored.blockers];
      return {
        jobId: s.job.id, score: scored.score, fits: scored.fits, missing: scored.missing, blockers,
        reasons: scored.reasons, from: text.from, chars: text.chars,
      } as Match;
    } catch (e: any) {
      skipped.push({ jobId: s.job.id, why: `scoring failed: ${String(e?.message ?? e).slice(0, 80)}` });
      return null;
    }
  });

  const matches = results.filter((m): m is Match => !!m)
    // Best first, and a blocked candidate never outranks an unblocked one however high the number:
    // a score of 90 with "no UK right to work" is not a better suggestion than an 80 without it.
    .sort((a, b) => (a.blockers.length ? 1 : 0) - (b.blockers.length ? 1 : 0) || b.score - a.score);

  return { matches, skipped, spentEur, ms: Date.now() - t0, concurrency };
}
