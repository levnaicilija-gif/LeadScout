import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { hasFollowupResolutions } from '@/lib/schema-features';

export const dynamic = 'force-dynamic';

/**
 * Marking a follow-up done (Today, 2026-09-17).
 *
 * A follow-up is derived — a pack or outreach with no reply, an answer still "unclear" — so there is
 * no row to tick. The resolution is its own record, keyed on what it was about (0042).
 *
 * RESOLVING NEVER DELETES OR HIDES (owner's decision): the row is the candidate's own activity
 * history, and it only stops the item appearing in tomorrow's active list. Nothing is ever removed
 * here, and there is no route that removes one.
 *
 *   POST { kind: 'no_reply' | 'unclear_answer', source_id, candidate_id?, note? }
 */
const KINDS = ['no_reply', 'unclear_answer'] as const;

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const sb = supabaseServer();
  if (!(await hasFollowupResolutions(sb))) {
    return NextResponse.json({ error: 'The follow-up table is not in the database yet (migration 0042).' }, { status: 409 });
  }

  const b = await req.json().catch(() => ({}));
  if (!(KINDS as readonly string[]).includes(String(b.kind))) {
    return NextResponse.json({ error: `kind must be one of ${KINDS.join(', ')}` }, { status: 400 });
  }
  if (!b.source_id || !/^[0-9a-f-]{36}$/i.test(String(b.source_id))) {
    return NextResponse.json({ error: 'source_id must be the id of the row this follow-up came from' }, { status: 400 });
  }

  // Written with the signed-in user's own client, so 0042's policy decides the workspace and refuses
  // a candidate belonging to another one — the hole the screening probe found in 0040.
  const row = {
    workspace_id: me.workspace_id,
    candidate_id: b.candidate_id ?? null,
    kind: String(b.kind),
    source_id: String(b.source_id),
    note: b.note ? String(b.note).slice(0, 2000) : null,
    resolved_by: me.id,
    resolved_at: new Date().toISOString(),
  };

  // Resolving twice is the same act, not two: 0042 has a unique key on (workspace, kind, source),
  // and a second click updates the note rather than failing in the recruiter's face.
  const { error } = await sb.from('followup_resolutions').upsert(row, { onConflict: 'workspace_id,kind,source_id' });
  if (error) return NextResponse.json({ error: `It was not marked done: ${error.message}` }, { status: 500 });

  return NextResponse.json({ ok: true, resolvedAt: row.resolved_at });
}
