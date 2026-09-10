import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { anonymize, candidateScreening, scoreAgainstJob } from '@/lib/ai/documents';
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
    const { candidate_id: candidateId, job } = await req.json();
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
    if (job) {
      score = await scoreAgainstJob(anon, verified ?? [], job);
      await db.from('scores').insert({ candidate_id: candidateId, ...score });
    }

    const { questions } = await candidateScreening(anon, verified ?? [], job ?? null, score);
    return NextResponse.json({ questions, score, basedOn: job ? 'the job on the right and this candidate\'s score against it' : 'this candidate\'s trade and documents' });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
