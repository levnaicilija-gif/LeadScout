import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { hasScorecards } from '@/lib/schema-features';

export const dynamic = 'force-dynamic';

/**
 * The days the team have written up, for a senior to read and answer.
 *
 * Only days somebody actually wrote on: a day with counts but no words is waiting for nobody, and
 * listing every person × every day would bury the ones that are. Read with the signed-in user's own
 * client, so 0039's policy decides what is visible rather than this route being trusted.
 */
export async function GET() {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  if (me.role !== 'senior') return NextResponse.json({ error: 'Only a senior reads the team\'s days.' }, { status: 403 });

  const sb = supabaseServer();
  if (!(await hasScorecards(sb))) return NextResponse.json({ ready: false, rows: [] });

  const { data, error } = await sb
    .from('scorecards')
    .select('user_id, day, notes, submitted_at, reply, users!user_id(name)')
    .eq('workspace_id', me.workspace_id)
    .not('submitted_at', 'is', null)
    .order('day', { ascending: false })
    .limit(60);
  // A screen must never report an absence it did not check (CLAUDE.md).
  if (error) return NextResponse.json({ error: `The team's scorecards could not be read: ${error.message}` }, { status: 500 });

  return NextResponse.json({
    ready: true,
    rows: (data ?? []).map((r: any) => ({
      user_id: r.user_id, day: r.day, notes: r.notes ?? '',
      submitted_at: r.submitted_at, reply: r.reply ?? null,
      name: r.users?.name ?? null,
    })),
  });
}
