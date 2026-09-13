-- 0027 — the worker queue is service-role only, and now says so.
--
-- Found 2026-09-13 by the RLS sweep's catalogue check (0026) the first time it ran: jobs has row level
-- security on and no policy, and no migration enables it — it was switched on outside the migrations,
-- like articles, lead_articles and lead_people before 0025. It has no rows, so counting rows as a
-- signed-in user could never judge it; Home's data access check went red naming it, as designed.
--
-- Unlike those three, nothing a signed-in user reads touches jobs: worker/index.ts polls it with the
-- service role key, which bypasses RLS. No screen was broken. But "RLS on, no policy" cannot say
-- whether that was intended, and that is the ambiguity the check exists to remove.
--
-- This grants nothing new. The service role bypasses RLS whatever the policies say, and anon and
-- authenticated users still read no rows. It records the intent in migration history and gives the
-- catalogue check a policy to find.

alter table jobs enable row level security;

drop policy if exists jobs_service_role_only on jobs;
create policy jobs_service_role_only on jobs for all to service_role using (true) with check (true);
