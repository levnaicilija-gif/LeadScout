-- 0043 — users.previous_visit_at: the boundary "since your last visit" actually counts from.
--
-- 0042 added last_seen_at and Today read it as both "when this visit started" and "when the previous
-- visit started". ONE column cannot hold both, and the moment it advances the previous boundary is
-- gone — so a reload inside a visit had no window left to name. That is not hypothetical: Today runs
-- <LiveRefresh minutes={5} />, so the visit window survived about five minutes and then widened to the
-- whole open queue for the rest of the session. Priority never emptied (the fallback is deliberate,
-- and is the same rule as a first-ever visit), but "everything since your last visit" was true only on
-- the first load of each visit.
--
-- This is not a second last-visit tracker — owner's decision, 2026-09-21. It is the SAME mechanism,
-- written by the SAME route (/api/me/visit) in the SAME branch, normalised so it can answer the
-- question that was already being asked of it:
--
--   last_seen_at      when THIS visit started
--   previous_visit_at when the visit before it started — the boundary shown and queried
--
-- The route moves both together and only when visitWindow says a real absence has passed (30 minutes,
-- src/lib/visit.ts): previous_visit_at takes the old last_seen_at, last_seen_at takes now. Nothing
-- else in the codebase writes either.
--
-- NO GRANT, deliberately. 0028 revoked insert/update/delete on users from anon and authenticated
-- because "nothing in the app writes users as a signed-in user", and 0042's failure to grant anything
-- back is precisely why last_seen_at sat NULL for four days while the page swallowed 42501. The answer
-- there was a service-role route, not an exception to 0028, and the same holds here: adding a column
-- the app can write directly would reopen the invariant one column at a time. users_update_self
-- (0028) still guards the row; no column is writable by a signed-in user, this one included.
--
-- Nullable and never backfilled. There is no honest value for "the visit before the one we recorded"
-- on a row that predates this migration, and a guess would put a boundary on screen that nobody was
-- ever away for. Until the route has seen one real absence per account the column stays null, and
-- visitWindow falls back to last_seen_at exactly as it behaved before 0043 — see hasPreviousVisit in
-- src/lib/schema-features.ts, which is how every screen survives this migration not being applied yet.

alter table users add column if not exists previous_visit_at timestamptz;

comment on column users.previous_visit_at is
  'When the visit BEFORE the current one began. Written only by /api/me/visit, through the service role, at the same moment last_seen_at advances. The boundary Today''s "while you were out" and Priority''s window both count from.';
