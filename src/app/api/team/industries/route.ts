import { NextResponse } from 'next/server';
import { currentUser, supabaseAdmin } from '@/lib/supabase/server';
import { checkFollow, canFollowAll } from '@/lib/industry-follow';
import { hasIndustryFollow } from '@/lib/schema-features';

/**
 * A senior's view of what the team follows, and adjusting it for someone (item 18 part 3).
 *
 *   GET                                  every member of the senior's workspace and what they follow
 *   POST { userId, follow: [...] }       set one member's choice for them
 *
 * Who is a senior, which workspace they are in, and the member's limit are all read from the database for the
 * signed-in session. A senior decides who edits, never how many: the member's own industry_limit caps the choice,
 * whatever the senior's own account allows. 0032's trigger enforces the same rules on the write.
 */
async function senior() {
  const user = await currentUser();
  if (!user) return { error: NextResponse.json({ error: 'unauthorised' }, { status: 401 }) };
  const db = supabaseAdmin();
  const { data: row, error } = await db.from('users').select('id, workspace_id, role').eq('id', user.id).single();
  if (error || !row) return { error: NextResponse.json({ error: `Your account could not be read: ${error?.message ?? 'no row'}` }, { status: 500 }) };
  if (row.role !== 'senior') return { error: NextResponse.json({ error: 'Only a senior can see or change what the team follows.' }, { status: 403 }) };
  if (!(await hasIndustryFollow(db))) return { error: NextResponse.json({ error: 'Following industries needs migration 0032.' }, { status: 503 }) };
  return { db, row };
}

export async function GET() {
  const s = await senior();
  if ('error' in s) return s.error;
  const { data, error } = await s.db.from('users')
    .select('id, name, role, industry_follow, industry_limit, industry_follow_set_at, industry_follow_set_by')
    .eq('workspace_id', s.row.workspace_id).order('name');
  if (error) return NextResponse.json({ error: `The team could not be read: ${error.message}` }, { status: 500 });
  return NextResponse.json({ members: (data ?? []).map((m) => ({ ...m, canFollowAll: canFollowAll(m.industry_limit) })) });
}

export async function POST(req: Request) {
  const s = await senior();
  if ('error' in s) return s.error;
  const body = await req.json().catch(() => ({}));
  if (typeof body?.userId !== 'string') return NextResponse.json({ error: 'Say whose choice to change.' }, { status: 400 });
  // The member, from the database and only inside the senior's own workspace.
  const { data: member, error } = await s.db.from('users').select('id, industry_limit').eq('id', body.userId).eq('workspace_id', s.row.workspace_id).maybeSingle();
  if (error) return NextResponse.json({ error: `The member could not be read: ${error.message}` }, { status: 500 });
  if (!member) return NextResponse.json({ error: 'No such member in your workspace.' }, { status: 404 });
  const check = checkFollow(body.follow, member.industry_limit);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  const { error: upErr } = await s.db.from('users')
    .update({ industry_follow: check.follow, industry_follow_set_at: new Date().toISOString(), industry_follow_set_by: s.row.id })
    .eq('id', member.id).eq('workspace_id', s.row.workspace_id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: upErr.code === '23514' ? 400 : 500 });
  return NextResponse.json({ ok: true, userId: member.id, follow: check.follow });
}
