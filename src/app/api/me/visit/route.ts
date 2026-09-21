import { NextResponse } from 'next/server';
import { currentUser, supabaseAdmin } from '@/lib/supabase/server';
import { hasLastSeen, hasPreviousVisit } from '@/lib/schema-features';
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

  // 0043 may not be applied; naming a column that does not exist fails the WHOLE query rather than
  // omitting the field, which has taken three screens down in this codebase before.
  const twoStamps = await hasPreviousVisit(db);
  const cols = `id, last_seen_at${twoStamps ? ', previous_visit_at' : ''}`;
  const { data: row, error } = await db.from('users').select(cols).eq('id', user.id).single();
  if (error || !row) return NextResponse.json({ error: `Your account could not be read: ${error?.message ?? 'no row'}` }, { status: 500 });

  const now = new Date();
  const wasSeen = (row as any).last_seen_at as string | null;
  const visit = visitWindow(wasSeen, now, twoStamps ? ((row as any).previous_visit_at ?? null) : undefined);
  // Still inside the same visit: both stamps stay exactly where they are. Writing here is what would
  // collapse "while you were out" into the last few minutes on every reload.
  if (!visit.advance) return NextResponse.json({ ok: true, advanced: false, since: visit.since?.toISOString() ?? null });

  // A real absence, so the pair moves together and in ONE write: the visit we are leaving behind
  // becomes the boundary, and this visit becomes the stamp. Two writes could be interrupted between
  // them and leave a row claiming this visit started now and the previous one did too.
  //
  // previous_visit_at takes the OLD last_seen_at, never `now` — on a first-ever visit that is null,
  // which is correct and is why the column is not backfilled: there was no previous visit to name.
  const patch = twoStamps
    ? { last_seen_at: now.toISOString(), previous_visit_at: wasSeen }
    : { last_seen_at: now.toISOString() };
  const { error: wrote } = await db.from('users').update(patch).eq('id', (row as any).id);
  // Reported as it came, never re-worded into a success — the whole reason this route exists is that
  // the previous write failed in silence for four days.
  if (wrote) return NextResponse.json({ error: wrote.message }, { status: 500 });
  return NextResponse.json({ ok: true, advanced: true, since: visit.since?.toISOString() ?? null, boundaryKept: twoStamps });
}
