import { NextResponse } from 'next/server';
import { supabaseAdmin, supabaseServer, currentUser } from '@/lib/supabase/server';
import { meterRecruiter } from '@/lib/ai/meter';
import { fetchPage } from '@/lib/fetch-page';
import { shortlistJobs } from '@/lib/job-shortlist';
import { scoreShortlist } from '@/lib/job-matches';
import { candidateFacts, openPostings, jobTextResolver, SUGGEST_SCOPE } from '@/lib/job-suggest';
export const maxDuration = 120;

/**
 * Which open jobs this person actually fits — item 25's suggestion list.
 *
 *   POST { candidate_id }
 *
 * Nothing here is attached, sent or confirmed: it returns a ranked list and a recruiter acts. The
 * expensive half (claude-sonnet-5, EUR 0.01535 a job) runs only on what the free pre-filter kept.
 *
 * NOT CAPPED BY THE DAILY BUDGET, deliberately, and this is the owner's standing decision for every
 * recruiter tool (item 16, re-issued 2026-09-15): a recruiter's own calls are RECORDED and counted
 * in the day's total — so a busy day stops the crawl earlier — but never blocked, because the cap
 * exists to protect production from the automated jobs, not to stop somebody doing their work. The
 * shortlist limit below is what bounds the spend instead, and it is a bound on a single drop rather
 * than on the day.
 */

/** Ten in, five shown. Ten at four-at-a-time is three waves — about 38 s at the measured 12.8 s a job. */
const SHORTLIST = 10;
const SHOW = 5;

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  // Item 16: every model call below is logged against this workspace as 'candidate-score'.
  return meterRecruiter(me, () => handle(req, me));
}

type SignedIn = NonNullable<Awaited<ReturnType<typeof currentUser>>>;
async function handle(req: Request, me: SignedIn) {
  try {
    const { candidate_id: candidateId } = await req.json();
    if (!candidateId) return NextResponse.json({ error: 'candidate_id required' }, { status: 400 });

    const db = supabaseAdmin();
    const { facts, error: factsError } = await candidateFacts(db, candidateId, me.workspace_id);
    if (!facts) return NextResponse.json({ error: factsError ?? 'candidate not found' }, { status: factsError?.includes('not found') ? 404 : 500 });

    // The postings are read as the SIGNED-IN USER, not the service role, so 0016's policy decides
    // exactly as it does for Hiring now. Measured 2026-09-22: 12 of the 55 open postings still carry
    // workspace_id null and are reachable only through their company, so a service-role read filtered
    // on workspace_id returns 43 and hides twelve real jobs from every suggestion — with nothing on
    // screen to say so. All 12 have a company, and every one of those companies is in this workspace.
    const { jobs, sources, error: jobsError } = await openPostings(supabaseServer());
    // A read that failed is said out loud rather than rendered as "no matches" — the Candidates
    // defect this codebase already records, which is what an unread { error } looks like on screen.
    if (jobsError) return NextResponse.json({ error: `the open postings could not be read: ${jobsError}` }, { status: 500 });

    const { keep, dropped } = shortlistJobs(facts.shortlist, jobs, SHORTLIST);
    if (!keep.length) {
      return NextResponse.json({
        scope: SUGGEST_SCOPE, considered: jobs.length, shortlisted: 0, matches: [], skipped: [],
        why: facts.noTradeReason
          ? `nothing to match on — ${facts.noTradeReason}`
          : 'no open posting is a plausible fit for this person',
        spentEur: 0, ms: 0,
      });
    }

    const run = await scoreShortlist(facts.match, keep, {
      jobText: jobTextResolver((id) => sources.get(id), (url) => fetchPage(url, { allowBrowser: false })),
    });

    // Company names for what is shown, read after scoring so nothing is fetched for a job that was
    // never scored. A name that cannot be read is left null and the row still renders.
    const shown = run.matches.slice(0, SHOW);
    const companyIds = [...new Set(shown.map((m) => sources.get(m.jobId)?.companyId).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (companyIds.length) {
      const { data: cos } = await db.from('companies').select('id, name').in('id', companyIds);
      for (const c of cos ?? []) names.set(c.id, c.name);
    }

    return NextResponse.json({
      scope: SUGGEST_SCOPE,
      considered: jobs.length,
      shortlisted: keep.length,
      droppedExamples: dropped.slice(0, 3).map((d) => d.why),
      matches: shown.map((m) => {
        const src = sources.get(m.jobId);
        return {
          ...m,
          role: src?.role ?? src?.title ?? null,
          company: src?.companyId ? names.get(src.companyId) ?? null : null,
          url: src?.sourceUrl ?? null,
          why: keep.find((k) => k.job.id === m.jobId)?.why ?? null,
        };
      }),
      skipped: run.skipped,
      ms: run.ms,
      spentEur: run.spentEur,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
