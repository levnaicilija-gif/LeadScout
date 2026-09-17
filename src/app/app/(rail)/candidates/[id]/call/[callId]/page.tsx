import Link from 'next/link';
import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { candidateLabel } from '@/lib/candidate-number';
import { hasScreeningCalls } from '@/lib/schema-features';
import { ScreeningCall } from '@/components/ScreeningCall';
export const dynamic = 'force-dynamic';

/**
 * The screening call itself (item 5): the questions as they were asked, in order, with room to write
 * down what the candidate says while they are saying it.
 *
 * A page rather than a panel, because this is read aloud during a phone call — one column, large
 * enough to follow at arm's length, and every answer saved as it is typed so a dropped call loses
 * nothing. SENSITIVE PERSONAL DATA: the rows are read with the signed-in user's client under
 * row-level security, and a call belonging to another candidate is a 404 even with a valid id.
 */
export default async function ScreeningCallPage({ params }: { params: { id: string; callId: string } }) {
  const sb = supabaseServer();
  if (!(await hasScreeningCalls(sb))) notFound();

  const { data: call, error } = await sb.from('screening_calls')
    .select('*, candidates!candidate_id(id, reference_code, full_name, trade), leads!lead_id(id, project_name, companies(name))')
    .eq('id', params.callId).maybeSingle() as { data: any; error: any };
  if (error) {
    return (
      <div className="bg-panel border border-bad rounded-card p-4 text-[13px]">
        <b className="text-bad">The call could not be read.</b>
        <details className="mt-1 text-[12px] text-ink3"><summary>Technical detail</summary><pre className="whitespace-pre-wrap">{error.message}</pre></details>
      </div>
    );
  }
  // The id in the URL proves nothing on its own: a call must belong to the candidate it is opened under.
  if (!call || call.candidate_id !== params.id) notFound();

  const { data: answers, error: aErr } = await sb.from('screening_answers')
    .select('*').eq('call_id', params.callId).order('position');
  if (aErr) {
    return (
      <div className="bg-panel border border-bad rounded-card p-4 text-[13px]">
        <b className="text-bad">The questions could not be read.</b>
        <details className="mt-1 text-[12px] text-ink3"><summary>Technical detail</summary><pre className="whitespace-pre-wrap">{aErr.message}</pre></details>
      </div>
    );
  }

  const c = call.candidates;
  const about = call.leads
    ? `${call.leads.companies?.name ?? 'a lead'}${call.leads.project_name ? ` · ${call.leads.project_name}` : ''}`
    : call.job_post_id ? 'a Hiring now posting' : 'no job attached';

  return (<>
    <div className="text-[13px] mb-3 flex flex-wrap gap-3 items-center justify-between">
      <Link href={`/app/candidates/${params.id}`} className="text-accent">← {candidateLabel(c?.reference_code)} · {c?.full_name ?? 'candidate'}</Link>
      <span className="text-ink3">
        {about}{typeof call.jd_version === 'number' ? ` · JD version ${call.jd_version}` : ''}
      </span>
    </div>
    <ScreeningCall
      callId={params.callId}
      candidateId={params.id}
      initialAnswers={answers ?? []}
      finishedAt={call.finished_at}
      needsRescore={!!call.needs_rescore}
      rescoreReason={call.rescore_reason}
      who={`${candidateLabel(c?.reference_code)} · ${c?.full_name ?? 'candidate'}${c?.trade ? ` · ${c.trade}` : ''}`}
    />
  </>);
}
