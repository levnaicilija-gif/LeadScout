import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { anonymize, candidateScreening, scoreWithRightToWork } from '@/lib/ai/documents';
import { checkRightToWork } from '@/lib/right-to-work';
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

  try {
    const { candidate_id: candidateId, job, job_country: jobCountry } = await req.json();
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

    const { questions } = await candidateScreening(anon, verified ?? [], job ?? null, score);
    // Right to work goes first when it is not already settled: a "no" ends the call, so it must
    // never be the eighth question.
    const ordered = rtw.question && rtw.verdict !== 'ok'
      ? [{ q: rtw.question, good_answer: rtw.rule }, ...questions.filter((x: any) => !/passport|right to work|settled status|work visa/i.test(x.q))]
      : questions;

    return NextResponse.json({
      questions: ordered, score, rightToWork: rtw,
      basedOn: job ? 'the job on the right and this candidate\'s score against it' : 'this candidate\'s trade and documents',
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
