import { NextResponse } from 'next/server';
import { currentUser, supabaseAdmin } from '@/lib/supabase/server';
import { FOLLOW_OPTIONS } from '@/lib/industry';
import { checkFollow, canFollowAll } from '@/lib/industry-follow';
import { hasIndustryFollow } from '@/lib/schema-features';

/**
 * The signed-in person's own industry follow (item 18 part 3, migration 0032).
 *
 *   GET                      what they follow, how many they may follow, and the options
 *   POST { follow: [...] }   choose — at onboarding or from Preferences
 *
 * Who is asking comes from the session (currentUser → auth.uid()), never from the request, and the limit is read
 * from their users row here, never taken from the request. A choice over the limit, or "all" under one, is refused
 * before anything is written. The write goes through the service role because signed-in users hold no write on
 * users (0028); 0032's trigger checks the same rules again on that write, so this route is not the only guard.
 */
async function me() {
  const user = await currentUser();
  if (!user) return { error: NextResponse.json({ error: 'unauthorised' }, { status: 401 }) };
  const db = supabaseAdmin();
  if (!(await hasIndustryFollow(db))) return { error: NextResponse.json({ error: 'Following industries needs migration 0032.' }, { status: 503 }) };
  const { data: row, error } = await db.from('users').select('id, workspace_id, industry_follow, industry_limit').eq('id', user.id).single();
  if (error || !row) return { error: NextResponse.json({ error: `Your account could not be read: ${error?.message ?? 'no row'}` }, { status: 500 }) };
  return { db, row };
}

export async function GET() {
  const r = await me();
  if ('error' in r) return r.error;
  return NextResponse.json({
    follow: r.row.industry_follow, limit: r.row.industry_limit, canFollowAll: canFollowAll(r.row.industry_limit),
    options: FOLLOW_OPTIONS.map((o) => ({ id: o.id, label: o.label })),
  });
}

export async function POST(req: Request) {
  const r = await me();
  if ('error' in r) return r.error;
  const body = await req.json().catch(() => ({}));
  const check = checkFollow(body?.follow, r.row.industry_limit);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  const { error } = await r.db.from('users')
    .update({ industry_follow: check.follow, industry_follow_set_at: new Date().toISOString(), industry_follow_set_by: r.row.id })
    .eq('id', r.row.id);
  // The database's own refusal (0032's trigger) is reported as it came, not re-worded into a success.
  if (error) return NextResponse.json({ error: error.message }, { status: error.code === '23514' ? 400 : 500 });
  return NextResponse.json({ ok: true, follow: check.follow });
}
