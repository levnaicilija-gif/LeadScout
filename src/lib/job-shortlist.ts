import { RFBT_TRADE_LIST, inferTrades, type Trade } from '@/lib/trades';
import { CERT_TABLE } from '@/lib/certs/tables';
import { checkRightToWork, type Rtw } from '@/lib/right-to-work';
import { isEuropean } from '@/lib/geo';
import { SENDABLE, type CertState } from '@/lib/verify/routes';

/**
 * Which open jobs are worth paying to score a candidate against — pure logic, no model call.
 *
 * WHY THIS EXISTS AT ALL, measured before a line of it was written (2026-09-22). The comparison this
 * feeds — scoreAgainstJob's fits, missing, blockers and one reason per requirement — is a
 * claude-sonnet-5 call costing EUR 0.01535 and 12.8 s, measured with a real call rather than
 * estimated. Running it across every open lead and posting is EUR 3.75 for ONE dropped CV, nearly
 * twice the whole daily cap. So the expensive half runs on a shortlist of ten or fifteen, and this
 * builds that shortlist out of rules that already exist and cost nothing.
 *
 * It is a FILTER, not a ranking of quality. Everything it does is cheap and structural — does this
 * person do this trade, may they legally work there, is the work in Europe — and it deliberately
 * makes no judgement the model is there to make. A job that survives is plausible, not good.
 *
 * NOTHING IS INVENTED HERE. The trade rules are trades.ts, which the crawl already uses; the trades a
 * certificate implies come from CERT_TABLE's own `trades` per entry (item 23's decode); right to work
 * is checkRightToWork unchanged, keyed on the JOB's country as it always is. If a rule is not already
 * written down somewhere in this codebase, it is not in here.
 */

export type ShortlistJob = {
  id: string;
  /** job_posts.trades, as the crawl inferred them. */
  trades?: (string | null)[] | null;
  /** Free text the advert used — read only where `trades` is empty, never instead of it. */
  role?: string | null;
  title?: string | null;
  country?: string | null;
  /** job_posts.certs_required — free text off the advert. */
  certsRequired?: (string | null)[] | null;
  /** The newest advert date, for ordering only. Never a reason to include or exclude. */
  postedAt?: string | null;
};

export type ShortlistCandidate = {
  /** candidates.trade, as a recruiter typed it. */
  trade?: string | null;
  /** Certificates on file, with the state that decides whether one counts as confirmed. */
  certificates?: { body?: string | null; certState?: string | null; validUntil?: string | null }[];
  /** Right-to-work facts, exactly as checkRightToWork already wants them. */
  rightToWork?: Rtw;
};

export type Shortlisted = {
  job: ShortlistJob;
  /** Every trade both sides agree on — the reason it survived. */
  trades: Trade[];
  /** Plain English, always set: why this job is worth scoring against. */
  why: string;
};

export type ShortlistResult = {
  keep: Shortlisted[];
  /** One line per job dropped, and why — a filter nobody can see is a filter nobody can correct. */
  dropped: { id: string; why: string }[];
};

/** The trades a candidate can actually cover: what they call themselves, plus what their certificates imply. */
export function candidateTrades(c: ShortlistCandidate): { trades: Trade[]; why: string[] } {
  const found = new Set<Trade>();
  const why: string[] = [];

  const stated = inferTrades([c.trade ?? ''], c.trade ?? '');
  for (const t of stated.trades) found.add(t as Trade);
  if (stated.trades.length) why.push(`stated trade ${c.trade}`);

  for (const cert of c.certificates ?? []) {
    const body = String(cert.body ?? '').toLowerCase();
    if (!body) continue;
    // Only a CONFIRMED certificate widens what somebody is put forward for. A line in a CV claiming a
    // CSWIP is the model's problem to weigh; a certificate the issuer's register confirmed is a fact,
    // and it is the only kind that should add a trade a recruiter never typed.
    const confirmed = !!cert.certState && (SENDABLE as string[]).includes(cert.certState as CertState);
    if (!confirmed) continue;
    const entry = (CERT_TABLE as any[]).find((e) => String(e.body).toLowerCase() === body);
    if (!entry?.trades?.length) continue;
    for (const t of entry.trades as Trade[]) found.add(t);
    why.push(`${body.toUpperCase()} confirmed — covers ${(entry.trades as Trade[]).join(', ')}`);
  }

  return { trades: [...found], why };
}

/** What a job asks for: the crawl's own trades, and only where it has none, the words of the advert. */
export function jobTrades(j: ShortlistJob): Trade[] {
  const stored = (j.trades ?? []).map((t) => String(t ?? '').toLowerCase()).filter(Boolean);
  const matched = stored.filter((t): t is Trade => (RFBT_TRADE_LIST as readonly string[]).includes(t));
  if (matched.length) return [...new Set(matched)];
  // An advert the crawl could not classify still says what it wants in words. Read as a fallback and
  // never as an override: a stored trade is what the pipeline decided, and it wins.
  //
  // The trade NAMES only, not trades.ts's SCOPE_RULES. Those rules read a project description — "pipe
  // mill" implies welders, NDT, blasters and painters — which is right for a lead and wrong for one
  // advert: fed "Scaffolder wanted for shutdown" they match "shutdown" and answer wind technician,
  // electrician, rope access and fitter, every one of them a trade the advert did not ask for, while
  // missing the one it did. An advert states its own trade; a project implies several.
  const text = [j.role, j.title, ...(j.certsRequired ?? [])].filter(Boolean).join(' ').toLowerCase();
  return RFBT_TRADE_LIST.filter((t) => text.includes(t)) as Trade[];
}

/**
 * Build the shortlist.
 *
 * Three gates, each already written down elsewhere, applied cheapest first:
 *
 *   1. TRADE  — the job and the candidate must share one. This is the filter that actually narrows:
 *               a welder is not a plausible scaffolder, however good the CV.
 *   2. RIGHT TO WORK — checkRightToWork against the JOB's country, unchanged. A blocker here is a
 *               blocker in the score too, so paying a model to rediscover it is pure waste.
 *   3. EUROPE — outside Europe is capped at 25 fit by the scoring rules anyway (fit.ts), so it is
 *               not worth EUR 0.015 to be told so.
 *
 * A job whose trades cannot be read at all is KEPT, not dropped: silence from the crawl is not
 * evidence against a job, and the shortlist errs towards paying for one more comparison rather than
 * hiding work from a recruiter. It says so in `why`, so an unreadable advert is visible rather than
 * quietly promoted.
 */
export function shortlistJobs(candidate: ShortlistCandidate, jobs: ShortlistJob[], limit = 12): ShortlistResult {
  const mine = candidateTrades(candidate);
  const keep: Shortlisted[] = [];
  const dropped: { id: string; why: string }[] = [];

  for (const job of jobs) {
    if (job.country && !isEuropean(job.country)) {
      dropped.push({ id: job.id, why: `outside Europe (${job.country}) — scoring caps these at 25 anyway` });
      continue;
    }
    const rtw = checkRightToWork(job.country ?? null, candidate.rightToWork ?? {});
    if (rtw.verdict === 'blocked') {
      dropped.push({ id: job.id, why: `right to work: ${rtw.blocker ?? rtw.rule}` });
      continue;
    }

    const wants = jobTrades(job);
    if (!wants.length) {
      keep.push({ job, trades: [], why: 'the advert states no trade this crawl can read — kept rather than hidden' });
      continue;
    }
    const shared = wants.filter((t) => mine.trades.includes(t));
    if (!shared.length) {
      dropped.push({ id: job.id, why: `wants ${wants.join(', ')}; this candidate covers ${mine.trades.join(', ') || 'no trade we can read'}` });
      continue;
    }
    keep.push({ job, trades: shared, why: `${shared.join(', ')}${mine.why.length ? ` — ${mine.why.join('; ')}` : ''}` });
  }

  // Newest advert first, so a tie is broken by the job most likely still to be open. Ordering only:
  // nothing here is included or excluded for its date.
  keep.sort((a, b) => String(b.job.postedAt ?? '').localeCompare(String(a.job.postedAt ?? '')));
  const over = keep.length - limit;
  if (over > 0) {
    for (const s of keep.slice(limit)) dropped.push({ id: s.job.id, why: `past the shortlist limit of ${limit}` });
  }
  return { keep: keep.slice(0, limit), dropped };
}
