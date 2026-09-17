import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { anonymize, candidateScreening, scoreWithRightToWork } from '@/lib/ai/documents';
import { meterRecruiter } from '@/lib/ai/meter';
import { checkRightToWork } from '@/lib/right-to-work';
import { previousEmployer } from '@/lib/previous-employer';
import { withStandardQuestions } from '@/lib/screening';
export const maxDuration = 120;

/**
 * STEP 3 of the CV flow: the questions to ask this person on the phone.
 *
 * Its own request, so the card can show the anonymised CV and the bullets while these are still
 * being written rather than holding everything back until the slowest step finishes.
 *
 *   POST { candidate_id, job? }
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  // Item 16: every model call below is logged against this workspace, and never stopped by the daily cap.
  return meterRecruiter(me, () => handle(req, me));
}

type SignedIn = NonNullable<Awaited<ReturnType<typeof currentUser>>>;
async function handle(req: Request, me: SignedIn) {

  try {
    const { candidate_id: candidateId, job, job_country: jobCountry, company_name: companyName, company_domain: companyDomain } = await req.json();
    if (!candidateId) return NextResponse.json({ error: 'candidate_id required' }, { status: 400 });

    const db = supabaseAdmin();
    const { data: cand } = await db.from('candidates').select('*')
      .eq('id', candidateId).eq('workspace_id', me.workspace_id).maybeSingle();
    if (!cand) return NextResponse.json({ error: 'candidate not found in this workspace' }, { status: 404 });

    const anon = anonymize((cand.profile ?? {}) as any);
    const { data: verified } = await db.from('verifications')
      .select('result, valid_until, checked_where, documents!inner(candidate_id, cert_body, extracted)')
      .eq('documents.candidate_id', candidateId);

    // With a job attached the questions come from the score, so the call goes at the gaps.
    let score: any = null;
    let rtw = checkRightToWork(jobCountry ?? null, cand as any);
    if (job) {
      score = await scoreWithRightToWork(anon, verified ?? [], job, jobCountry ?? null, cand as any);
      rtw = score.rightToWork;
      const { rightToWork, ...row } = score;
      await db.from('scores').insert({ candidate_id: candidateId, ...row });
    }

    const { questions: fromModel } = await candidateScreening(anon, verified ?? [], job ?? null, score);
    // Item 5: the seven fixed questions are appended in code, so their kind — and therefore the
    // verdict control on the call — is certain rather than a model's label (owner's decision).
    // Only with a job attached: without one the prompt already covers the same ground itself.
    const questions = job ? withStandardQuestions(fromModel) : fromModel;
    // Right to work goes first when it is not already settled: a "no" ends the call, so it must
    // never be the eighth question.
    // Item 5: this one is injected in code, so its kind is certain rather than a model's label —
    // and it is the question whose answer decides whether someone may start at all, so it must
    // carry the yes/no/unclear control on the call.
    const ordered = rtw.question && rtw.verdict !== 'ok'
      ? [{ q: rtw.question, good_answer: rtw.rule, kind: 'right_to_work', subject: '' }, ...questions.filter((x: any) => !/passport|right to work|settled status|work visa/i.test(x.q))]
      : questions;

    // Item 11: worked out here from the candidate's own stored CV, never taken from the caller —
    // the browser posts the company being scored against, not the verdict about this person.
    const prev = previousEmployer((cand.profile ?? {}) as any, { name: companyName, domain: companyDomain }, cand.current_employer);
    const withPrev = prev
      ? [...ordered, { q: prev.question, good_answer: prev.goodAnswer }]
      : ordered;

    return NextResponse.json({
      questions: withPrev, score, rightToWork: rtw, previousEmployer: prev,
      basedOn: job ? 'the job on the right and this candidate\'s score against it' : 'this candidate\'s trade and documents',
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
