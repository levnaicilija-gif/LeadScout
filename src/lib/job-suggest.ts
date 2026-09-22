import type { SupabaseClient } from '@supabase/supabase-js';
import { allRows } from '@/lib/all-rows';
import { anonymize } from '@/lib/ai/documents';
import { SENDABLE, type CertState } from '@/lib/verify/routes';
import type { ShortlistJob, ShortlistCandidate } from '@/lib/job-shortlist';
import type { JobText, MatchCandidate } from '@/lib/job-matches';

/**
 * The data behind a job suggestion: who the candidate is, which postings are open, and — the part
 * with any judgement in it — what text a posting is actually scored against.
 *
 * WHY THE TEXT IS THE HARD PART. 0 of 55 open postings carry a stored description (measured
 * 2026-09-22, unchanged since step 2), so for every one of them the advert has to be re-read from
 * `source_url`. That is free and it is present on all 55 — but a re-read can just as easily land on
 * the board's LISTING page as on the advert, and a listing page carries twenty other companies'
 * requirements. Handing that to scoreAgainstJob, which asks for "one reason per requirement the job
 * actually states", is the invented-requirement failure this codebase refuses everywhere else —
 * except here it would invent them from a real advert belonging to somebody else.
 *
 * So a re-read is trusted only where the page proves it is the right page: the advert's own title
 * has to appear in it, and the text handed on is the window around that title rather than the whole
 * document. A page that cannot show the title is not treated as an error — it falls back to the
 * title alone, marked `from: 'title'`, so the recruiter sees a suggestion built on 37 characters as
 * exactly that.
 */

/** Below this there is nothing to judge, whatever the page returned. */
const MIN_CHARS = 200;
/** How much of a proven advert page to keep, centred on its title. */
const WINDOW = 6_000;

/** LEADS ARE DELIBERATELY NOT INCLUDED — see `suggestionScope` below. */
export const SUGGEST_SCOPE = 'open Hiring now postings';

/**
 * Why a suggestion list covers postings and not won-work leads (decided on measurement, 2026-09-22).
 *
 * scoreAgainstJob refuses without a job description — score_pool answers "Create the job description
 * first" — and only 2 of 189 open won-work leads have one. Writing the other 187 is EUR 0.011 each,
 * EUR 2.06, over the whole daily cap on its own, for a feature nobody has used yet. The queue item
 * names this trap explicitly and says not to quietly generate them to make a feature work, so the
 * first version says plainly what it looked at instead of silently looking at half the board.
 */
export const suggestionScope = () => SUGGEST_SCOPE;

/** Everything the shortlist and the scorer need about one person, read once. */
export type CandidateFacts = {
  id: string;
  name: string | null;
  shortlist: ShortlistCandidate;
  match: MatchCandidate;
  /** Set when the person has no trade we can read — the caller says so rather than showing nothing. */
  noTradeReason?: string;
};

export async function candidateFacts(db: SupabaseClient, candidateId: string, workspaceId: string): Promise<{ facts: CandidateFacts | null; error: string | null }> {
  const { data: cand, error } = await db.from('candidates').select('*')
    .eq('id', candidateId).eq('workspace_id', workspaceId).maybeSingle();
  if (error) return { facts: null, error: error.message };
  if (!cand) return { facts: null, error: 'candidate not found in this workspace' };

  // The certificate's STATE decides whether it widens what somebody is put forward for, and that is
  // `verifications.state` — the column the card already reads — never the recruiter's say-so.
  const { data: vers, error: vErr } = await db.from('verifications')
    .select('result, state, valid_until, checked_where, documents!inner(candidate_id, cert_body, extracted)')
    .eq('documents.candidate_id', candidateId);
  if (vErr) return { facts: null, error: `the certificates could not be read: ${vErr.message}` };

  const certificates = (vers ?? []).map((v: any) => ({
    body: v.documents?.cert_body ?? null,
    certState: v.state ?? null,
    validUntil: v.valid_until ?? null,
  }));

  const profile = (cand.profile ?? {}) as any;
  const trade = cand.trade ?? profile.trade ?? null;
  const rightToWork = { nationality: cand.nationality, eu_passport: cand.eu_passport, uk_right_to_work: cand.uk_right_to_work };
  const confirmed = certificates.filter((c) => c.certState && (SENDABLE as string[]).includes(c.certState as CertState));

  return {
    facts: {
      id: cand.id,
      name: cand.full_name ?? profile.full_name ?? null,
      shortlist: { trade, certificates, rightToWork },
      // anonymize() strips employers before the prompt sees the CV — the same call every other
      // scoring path makes, so a suggestion can never leak where somebody works.
      match: { anon: anonymize(profile), verified: vers ?? [], rightToWork },
      noTradeReason: !trade && !confirmed.length
        ? 'no trade on the record and no confirmed certificate to imply one'
        : undefined,
    },
    error: null,
  };
}

/** The extra columns the text resolver needs, keyed by job id — kept off ShortlistJob, which is a filter's input. */
export type JobSource = { sourceUrl?: string | null; description?: string | null; role?: string | null; title?: string | null; companyId?: string | null };

/**
 * Every open posting this recruiter can see, read through allRows so 1,000 is not a silent ceiling.
 *
 * `db` MUST be the signed-in user's client, never the service role, and there is deliberately no
 * `workspace_id` filter: 0016's policy has three arms and the third reaches a posting through its
 * COMPANY, which is the only thing making 12 of the 55 open postings visible at all — they still
 * carry `workspace_id` null from the writer fixed in eb64fd2, and their backfill migration is not
 * written yet. Filtering on the column here would have quietly hidden those twelve from every
 * suggestion while Hiring now went on showing them, which is this codebase's most repeated bug and
 * the hardest to notice: a screen that is simply missing rows looks like a workspace with fewer jobs.
 */
export async function openPostings(db: SupabaseClient): Promise<{ jobs: ShortlistJob[]; sources: Map<string, JobSource>; error: string | null }> {
  const { data, error } = await allRows<any>((from, to) =>
    db.from('job_posts')
      .select('id, role, title, trades, country, certs_required, posted_at, source_url, description, company_id')
      .eq('status', 'open')
      .order('id').range(from, to));
  if (error) return { jobs: [], sources: new Map(), error: error.message };
  const rows = data ?? [];
  return {
    jobs: rows.map((p) => ({
      id: p.id, role: p.role, title: p.title, trades: p.trades, country: p.country,
      certsRequired: p.certs_required, postedAt: p.posted_at,
    })),
    sources: new Map(rows.map((p) => [p.id, {
      sourceUrl: p.source_url, description: p.description, role: p.role, title: p.title, companyId: p.company_id,
    }])),
    error: null,
  };
}

/**
 * The window of a page around the advert's own title.
 *
 * Exported for its own sake: this is the rule that decides whether a re-read is the advert or
 * somebody else's, and it is worth testing without a network.
 */
export function windowAroundTitle(text: string, title: string, window = WINDOW): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const hay = norm(text);
  const needle = norm(title);
  if (!needle) return null;
  const at = hay.indexOf(needle);
  if (at < 0) return null;                       // not this advert's page — do not score against it
  if (hay.length <= window) return text.replace(/\s+/g, ' ').trim();
  const start = Math.max(0, at - Math.floor(window / 3));
  return text.replace(/\s+/g, ' ').trim().slice(start, start + window);
}

/**
 * What a posting is scored against: its stored description, else the advert re-read and proved, else
 * its title alone. Every answer says which, and job-matches carries that onto the match.
 *
 * `fetcher` is injected so this is testable without a network and without a model.
 */
export function jobTextResolver(
  sourceOf: (jobId: string) => JobSource | undefined,
  fetcher: (url: string) => Promise<{ text: string; status: string }>,
) {
  return async (s: { job: { id: string } }): Promise<JobText | null> => {
    const src = sourceOf(s.job.id);
    if (!src) return null;
    const printed = String(src.role ?? src.title ?? '').trim();

    const stored = String(src.description ?? '').trim();
    if (stored.length >= MIN_CHARS) return { text: stored, from: 'description', chars: stored.length };

    const url = String(src.sourceUrl ?? '').trim();
    if (url) {
      try {
        const page = await fetcher(url);
        if (page.status === 'live') {
          const win = windowAroundTitle(page.text ?? '', printed);
          if (win && win.length >= MIN_CHARS) return { text: win, from: 'fetched', chars: win.length };
        }
      } catch { /* a page that cannot be read is not an error here — the title still says something */ }
    }

    // Nothing but the title. Returned rather than skipped, because a title IS what the crawl has for
    // all 55 of these and a recruiter can judge a thin suggestion that says it is thin.
    if (printed.length >= 4) return { text: printed, from: 'title', chars: printed.length };
    return null;
  };
}
