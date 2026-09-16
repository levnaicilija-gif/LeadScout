import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { hasScorecards, hasSendsCreatedAt } from '@/lib/schema-features';
import { countsFor, lines, anyTarget, type CountKey, LABELS } from '@/lib/scorecard';

export const dynamic = 'force-dynamic';

/**
 * The daily scorecard: counts read from the data, and the words people write about them.
 *
 * Everything is written with the signed-in user's own client, so 0039's policies — each with a
 * WITH CHECK — decide what may be written and into which workspace, rather than this route being
 * trusted. Until 0039 is applied, every call answers `ready: false` and the screens show nothing.
 *
 *   GET  ?day=YYYY-MM-DD[&user=<id>]   the six counts, the targets, and anything written
 *   POST { action: 'targets', user_id?, targets }   a senior sets what a day should hold
 *   POST { action: 'notes', day, notes }            the recruiter's own three lines
 *   POST { action: 'reply', day, user_id, reply }   a senior answers, in their own words
 */
const today = () => new Date().toISOString().slice(0, 10);
const isDay = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const sb = supabaseServer();
  if (!(await hasScorecards(sb))) return NextResponse.json({ ready: false });

  const p = new URL(req.url).searchParams;
  const day = isDay(p.get('day')) ? (p.get('day') as string) : today();
  // A senior may read a colleague's day; anyone else reads only their own.
  const userId = me.role === 'senior' && p.get('user') ? (p.get('user') as string) : me.id;

  const sendsDated = await hasSendsCreatedAt(sb);
  const [{ counts, caveats, unavailable }, targetRow, own, card] = await Promise.all([
    countsFor(sb, { workspaceId: me.workspace_id, userId, day, sendsHasCreatedAt: sendsDated }),
    sb.from('scorecard_targets').select('*').eq('workspace_id', me.workspace_id).eq('user_id', userId).maybeSingle(),
    sb.from('scorecard_targets').select('*').eq('workspace_id', me.workspace_id).is('user_id', null).maybeSingle(),
    sb.from('scorecards').select('*').eq('workspace_id', me.workspace_id).eq('user_id', userId).eq('day', day).maybeSingle(),
  ]);

  // A target set for the person wins; otherwise the workspace's own; otherwise nothing is measured.
  const targets = (targetRow.data ?? own.data ?? null) as any;
  return NextResponse.json({
    ready: true, day, userId,
    lines: lines(counts, targets, caveats),
    targetsSet: anyTarget(targets),
    unavailable,
    notes: card.data?.notes ?? '',
    submittedAt: card.data?.submitted_at ?? null,
    reply: card.data?.reply ?? null,
    repliedAt: card.data?.replied_at ?? null,
    canReply: me.role === 'senior' && userId !== me.id,
  });
}

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const sb = supabaseServer();
  if (!(await hasScorecards(sb))) {
    return NextResponse.json({ error: 'The scorecard tables are not in the database yet (migration 0039).' }, { status: 409 });
  }
  const b = await req.json().catch(() => ({}));

  if (b.action === 'targets') {
    if (me.role !== 'senior') return NextResponse.json({ error: 'Only a senior sets the targets.' }, { status: 403 });
    const patch: Record<string, number | null> = {};
    for (const k of Object.keys(LABELS) as CountKey[]) {
      const v = b.targets?.[k];
      if (v === null || v === undefined || v === '') { patch[k] = null; continue; }
      const n = Number(v);
      // A target is a whole number of things done in a day. A wrong one is refused by name, and
      // nothing else is saved — the same rule the candidate edit follows.
      if (!Number.isInteger(n) || n < 0 || n > 999) {
        return NextResponse.json({ error: `${LABELS[k]}: a target is a whole number between 0 and 999.` }, { status: 400 });
      }
      patch[k] = n;
    }
    const row = {
      workspace_id: me.workspace_id,
      user_id: b.user_id ?? null,
      ...patch,
      set_by: me.id,
      set_at: new Date().toISOString(),
    };
    const { error } = await sb.from('scorecard_targets').upsert(row, { onConflict: 'workspace_id,user_id' });
    if (error) return NextResponse.json({ error: `The targets were not saved: ${error.message}` }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (b.action === 'notes') {
    if (!isDay(b.day)) return NextResponse.json({ error: 'day must be YYYY-MM-DD' }, { status: 400 });
    const notes = String(b.notes ?? '').slice(0, 2000);
    const { error } = await sb.from('scorecards').upsert({
      workspace_id: me.workspace_id, user_id: me.id, day: b.day,
      notes, submitted_at: notes.trim() ? new Date().toISOString() : null,
    }, { onConflict: 'workspace_id,user_id,day' });
    if (error) return NextResponse.json({ error: `Your lines were not saved: ${error.message}` }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (b.action === 'reply') {
    if (me.role !== 'senior') return NextResponse.json({ error: 'Only a senior replies to a scorecard.' }, { status: 403 });
    if (!isDay(b.day) || !b.user_id) return NextResponse.json({ error: 'day and user_id are required' }, { status: 400 });
    const { error } = await sb.from('scorecards').update({
      reply: String(b.reply ?? '').slice(0, 2000), replied_by: me.id, replied_at: new Date().toISOString(),
    }).eq('workspace_id', me.workspace_id).eq('user_id', b.user_id).eq('day', b.day);
    if (error) return NextResponse.json({ error: `The reply was not saved: ${error.message}` }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
