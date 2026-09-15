import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { hasCandidateCrm } from '@/lib/schema-features';
import { STAGES, STAGE_LABEL, type Stage } from '@/lib/candidate-stages';

/**
 * Move a candidate between stages (item 24) — from the table, a kanban drag, or the candidate's page. SENSITIVE PERSONAL
 * DATA: written with the signed-in user's client, so row-level security (0001 on candidates, 0035 on placements) decides.
 *
 *   POST { candidate_id, stage, placement?: { client, placed_on }, ended_on? }
 *
 * Placed is a record, not a label: moving to Placed needs the client and the date, and writes a candidate_placements row
 * with placed_by and placed_at, so "who is currently placed at AIBEL" is a query. Moving someone out of Placed ends their
 * open placement on the date given (the screen asks, today by default) — a placement is never silently left open or
 * silently deleted. Every move records stage_changed_by and stage_changed_at.
 */
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const sb = supabaseServer();
  if (!(await hasCandidateCrm(sb))) return NextResponse.json({ error: 'Stages arrive with migration 0035, which is not applied yet.' }, { status: 409 });

  const b = await req.json().catch(() => ({}));
  const stage = String(b.stage ?? '') as Stage;
  if (!b.candidate_id || !(STAGES as readonly string[]).includes(stage)) return NextResponse.json({ error: 'candidate_id and a stage (new, screening, presented, placed, bench) are required' }, { status: 400 });

  const { data: cand, error: readError } = await sb.from('candidates').select('id, workspace_id, stage, full_name, reference_code').eq('id', b.candidate_id).maybeSingle();
  if (readError) return NextResponse.json({ error: `the candidate could not be read: ${readError.message}` }, { status: 500 });
  if (!cand) return NextResponse.json({ error: 'no such candidate in your workspace' }, { status: 404 });

  const now = new Date().toISOString();
  const { data: open } = await sb.from('candidate_placements').select('id, client_name, placed_on').eq('candidate_id', cand.id).is('ended_on', null);

  if (stage === 'placed') {
    const client = String(b.placement?.client ?? '').trim();
    const placedOn = b.placement?.placed_on;
    if (!client || !isDate(placedOn)) return NextResponse.json({ error: 'Placed needs the client and the date the placement starts.' }, { status: 400 });
    // Placed at the same client with a placement still open is the same placement — say so rather than open a second.
    const same = (open ?? []).find((p: any) => p.client_name.toLowerCase() === client.toLowerCase());
    if (!same) {
      const { error } = await sb.from('candidate_placements').insert({ workspace_id: cand.workspace_id, candidate_id: cand.id, client_name: client, placed_on: placedOn, placed_by: me.id, placed_at: now, note: b.placement?.note ?? null });
      if (error) return NextResponse.json({ error: `the placement could not be recorded: ${error.message}` }, { status: 500 });
    }
  } else if (cand.stage === 'placed' && (open ?? []).length) {
    if (!isDate(b.ended_on)) {
      return NextResponse.json({ error: `${cand.full_name ?? 'This candidate'} is placed at ${(open ?? []).map((p: any) => p.client_name).join(', ')}. Moving them to ${STAGE_LABEL[stage]} ends that placement — give the end date.`, needsEndDate: true, open }, { status: 400 });
    }
    const { error } = await sb.from('candidate_placements').update({ ended_on: b.ended_on }).eq('candidate_id', cand.id).is('ended_on', null).lte('placed_on', b.ended_on);
    if (error) return NextResponse.json({ error: `the placement could not be ended: ${error.message}` }, { status: 500 });
  }

  const { error: updError } = await sb.from('candidates').update({ stage, stage_changed_at: now, stage_changed_by: me.id }).eq('id', cand.id);
  if (updError) return NextResponse.json({ error: `the stage could not be saved: ${updError.message}` }, { status: 500 });
  const { data: placements } = await sb.from('candidate_placements').select('client_name, placed_on, ended_on, placed_by, placed_at').eq('candidate_id', cand.id).order('placed_on', { ascending: false });
  return NextResponse.json({ ok: true, stage, stageLabel: STAGE_LABEL[stage], placements: placements ?? [] });
}
