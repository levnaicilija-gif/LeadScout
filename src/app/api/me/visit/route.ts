import { NextResponse } from 'next/server';
import { currentUser, supabaseAdmin } from '@/lib/supabase/server';
import { hasLastSeen } from '@/lib/schema-features';
import { visitWindow } from '@/lib/visit';

/**
 * Stamp users.last_seen_at for the signed-in person — the ONE write behind "while you were out" and,
 * since this item, behind Priority's window as well.
 *
 *   POST   → { ok, advanced, since }
 *
 * WHY THIS ROUTE EXISTS AT ALL. Today's page did this write itself, inline, with the SIGNED-IN USER's
 * client — and it had never once landed. 0028 revoked update on users from authenticated ("role,
 * workspace and onboarding day are the service role's to set") and 0042 added last_seen_at without
 * granting anything back, so every attempt answered 42501 permission denied for table users and the
 * page discarded the error. Both real accounts still read NULL four days after the feature shipped.
 * today-probe never caught it because it seeds the stamp with the service role, which proves the
 * display given a stamp and never that the app can write one.
 *
 * Owner's decision, 2026-09-21: fix it HERE, as a service-role route on /api/me/industries' pattern,
 * rather than granting update(last_seen_at) back to authenticated — 0028's invariant is that a
 * signed-in user writes nothing on users, and one narrow exception is how that invariant stops being
 * one. Who is asking comes from the session, never from the request, and the only column written is
 * this one on the caller's own row.
 *
 * The 30-minute rule is NOT re-implemented here: visitWindow owns it (src/lib/visit.ts), the route
 * asks it whether this counts as a new visit, and a mid-visit call writes nothing. That keeps one
 * copy of the rule for the page that reads the boundary and the route that moves it.
 */
export async function POST() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const db = supabaseAdmin();
  if (!(await hasLastSeen(db))) return NextResponse.json({ error: 'Visit tracking needs migration 0042.' }, { status: 503 });

  const { data: row, error } = await db.from('users').select('id, last_seen_at').eq('id', user.id).single();
  if (error || !row) return NextResponse.json({ error: `Your account could not be read: ${error?.message ?? 'no row'}` }, { status: 500 });

  const now = new Date();
  const visit = visitWindow((row as any).last_seen_at, now);
  // Still inside the same visit: the boundary stays exactly where it is. Writing here is what would
  // collapse "while you were out" into the last few minutes on every reload.
  if (!visit.advance) return NextResponse.json({ ok: true, advanced: false, since: visit.since?.toISOString() ?? null });

  const { error: wrote } = await db.from('users').update({ last_seen_at: now.toISOString() }).eq('id', row.id);
  // Reported as it came, never re-worded into a success — the whole reason this route exists is that
  // the previous write failed in silence for four days.
  if (wrote) return NextResponse.json({ error: wrote.message }, { status: 500 });
  return NextResponse.json({ ok: true, advanced: true, since: visit.since?.toISOString() ?? null });
}
