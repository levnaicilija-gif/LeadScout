import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { hasScreeningCalls } from '@/lib/schema-features';
import { rescoreReason, type AnswerRow } from '@/lib/screening';

export const dynamic = 'force-dynamic';

/**
 * The screening call: the questions as they were asked, and what the candidate said.
 *
 * Everything is written with the signed-in user's own client, so 0040's policies decide what may be
 * written and into which workspace rather than this route being trusted. Until 0040 is applied every
 * call answers `ready: false` and the screens carry nothing.
 *
 *   GET  ?call=<id>                      one call with its answers
 *   GET  ?candidate=<id>[&lead=<id>]     that candidate's calls, newest first
 *   POST { action: 'start', candidate_id, lead_id?, job_post_id?, jd_version?, score_id?, questions[] }
 *   POST { action: 'answer', call_id, position, answer?, verdict? }
 *   POST { action: 'finish', call_id }
 *
 * The questions are COPIED IN, not referenced: a JD can be rewritten and its questions regenerated,
 * and a pointer would let that silently reattribute yesterday's answers to a question nobody asked.
 */
const VERDICTS = ['yes', 'no', 'unclear', 'confirmed', 'not_confirmed'] as const;
const KINDS = ['right_to_work', 'certificate', 'availability', 'rate', 'open'] as const;

export async function GET(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const sb = supabaseServer();
  if (!(await hasScreeningCalls(sb))) return NextResponse.json({ ready: false, calls: [] });

  const p = new URL(req.url).searchParams;
  const callId = p.get('call');
  const candidateId = p.get('candidate');

  if (callId) {
    const { data: call, error } = await sb.from('screening_calls').select('*').eq('id', callId).maybeSingle();
    if (error) return NextResponse.json({ error: `The call could not be read: ${error.message}` }, { status: 500 });
    if (!call) return NextResponse.json({ error: 'no such call in this workspace' }, { status: 404 });
    const { data: answers, error: aErr } = await sb.from('screening_answers').select('*').eq('call_id', callId).order('position');
    if (aErr) return NextResponse.json({ error: `The answers could not be read: ${aErr.message}` }, { status: 500 });
    return NextResponse.json({ ready: true, call, answers: answers ?? [] });
  }

  if (!candidateId) return NextResponse.json({ error: 'call or candidate is required' }, { status: 400 });
  let q = sb.from('screening_calls').select('*').eq('candidate_id', candidateId).order('started_at', { ascending: false }).limit(20);
  if (p.get('lead')) q = q.eq('lead_id', p.get('lead') as string);
  const { data: calls, error } = await q;
  // A screen must never report an absence it did not check (CLAUDE.md).
  if (error) return NextResponse.json({ error: `The calls could not be read: ${error.message}` }, { status: 500 });
  return NextResponse.json({ ready: true, calls: calls ?? [] });
}

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const sb = supabaseServer();
  if (!(await hasScreeningCalls(sb))) {
    return NextResponse.json({ error: 'The screening tables are not in the database yet (migration 0040).' }, { status: 409 });
  }
  const b = await req.json().catch(() => ({}));

  if (b.action === 'start') {
    if (!b.candidate_id) return NextResponse.json({ error: 'candidate_id is required' }, { status: 400 });
    const questions = Array.isArray(b.questions) ? b.questions : [];
    if (questions.length === 0) return NextResponse.json({ error: 'Generate the questions before starting the call.' }, { status: 400 });

    // The candidate must be this workspace's — read with the user's own client, so RLS decides.
    const { data: cand } = await sb.from('candidates').select('id').eq('id', b.candidate_id).maybeSingle();
    if (!cand) return NextResponse.json({ error: 'candidate not found in this workspace' }, { status: 404 });

    const { data: call, error } = await sb.from('screening_calls').insert({
      workspace_id: me.workspace_id, candidate_id: b.candidate_id,
      lead_id: b.lead_id ?? null, job_post_id: b.job_post_id ?? null,
      jd_version: typeof b.jd_version === 'number' ? b.jd_version : null,
      score_id: b.score_id ?? null, started_by: me.id,
    }).select('*').single();
    if (error) return NextResponse.json({ error: `The call could not be started: ${error.message}` }, { status: 500 });

    const rows = questions.slice(0, 12).map((q: any, i: number) => ({
      call_id: call.id, position: i,
      question: String(q?.q ?? '').slice(0, 1000),
      good_answer: String(q?.good_answer ?? '').slice(0, 1000),
      kind: (KINDS as readonly string[]).includes(String(q?.kind)) ? String(q.kind) : 'open',
      subject: String(q?.subject ?? '').slice(0, 120) || null,
    })).filter((r: any) => r.question);
    const { error: aErr } = await sb.from('screening_answers').insert(rows);
    if (aErr) {
      // Do not leave a call with no questions in it standing.
      await sb.from('screening_calls').delete().eq('id', call.id);
      return NextResponse.json({ error: `The questions could not be saved: ${aErr.message}` }, { status: 500 });
    }
    const { data: answers } = await sb.from('screening_answers').select('*').eq('call_id', call.id).order('position');
    return NextResponse.json({ ok: true, call, answers: answers ?? [] });
  }

  if (b.action === 'answer') {
    if (!b.call_id || typeof b.position !== 'number') return NextResponse.json({ error: 'call_id and position are required' }, { status: 400 });
    if (b.verdict != null && !(VERDICTS as readonly string[]).includes(String(b.verdict))) {
      return NextResponse.json({ error: `verdict must be one of ${VERDICTS.join(', ')}` }, { status: 400 });
    }
    const patch: Record<string, unknown> = { answered_at: new Date().toISOString(), answered_by: me.id };
    // The prose is stored exactly as typed and is never read for meaning — only the recruiter's own
    // verdict can mark a re-score (owner's decision, 2026-09-16).
    if (b.answer !== undefined) patch.answer = String(b.answer ?? '').slice(0, 4000);
    if (b.verdict !== undefined) patch.verdict = b.verdict ?? null;
    const { error } = await sb.from('screening_answers').update(patch).eq('call_id', b.call_id).eq('position', b.position);
    if (error) return NextResponse.json({ error: `The answer was not saved: ${error.message}` }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (b.action === 'finish') {
    if (!b.call_id) return NextResponse.json({ error: 'call_id is required' }, { status: 400 });
    const { data: answers, error } = await sb.from('screening_answers').select('*').eq('call_id', b.call_id).order('position');
    if (error) return NextResponse.json({ error: `The call could not be read back: ${error.message}` }, { status: 500 });

    // Worked out in code from the recruiter's verdicts alone. No model reads the answers.
    const reason = rescoreReason((answers ?? []) as AnswerRow[]);
    const { error: fErr } = await sb.from('screening_calls').update({
      finished_at: new Date().toISOString(),
      needs_rescore: !!reason, rescore_reason: reason,
    }).eq('id', b.call_id);
    if (fErr) return NextResponse.json({ error: `The call was not closed: ${fErr.message}` }, { status: 500 });
    return NextResponse.json({ ok: true, needsRescore: !!reason, rescoreReason: reason });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
