-- 0038: make sure the deletion log is really there, and that the app's own key can see it.
--
-- 0037 was applied on 2026-09-15 and its delete function answers to this day. Its table, though, went missing: on
-- 2026-09-16 `deletion_log` read cleanly through the service role a dozen times, then — after a `notify pgrst, 'reload
-- schema'` — answered PGRST205 ("Could not find the table") to BOTH the anon key and the service role, while every other
-- table answered normally. A missing grant cannot do that (the service role bypasses grants), so the table itself is not
-- in the database and the earlier reads were being served from a cache entry left over from when it was.
--
-- Everything here is idempotent and safe to run whichever state the database is in: the table is created only if it is
-- missing, the policy is replaced, and the grants are stated outright rather than left to whatever the defaults were when
-- the table was created. Nothing is dropped, and no row is touched.
--
-- Until this is applied, the candidate page says deleting a candidate "arrives with migration 0037" and the delete route
-- refuses — which is the right behaviour, and is what the delete probe reports.

create table if not exists deletion_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  kind text not null check (kind in ('candidate', 'document')),
  subject_id uuid not null,                  -- the id of what was deleted; nothing references it afterwards
  subject_ref text not null,                 -- '#9 · RFBT-F-0009', or 'certificate frosio' — never a person's name
  deleted_by uuid references users(id) on delete set null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,                  -- null while running, and on a deletion that failed (see error)
  removed jsonb,                             -- rows per table and files per bucket actually removed
  error text
);
create index if not exists deletion_log_workspace_idx on deletion_log (workspace_id, requested_at desc);

alter table deletion_log enable row level security;
drop policy if exists deletion_log_read on deletion_log;
create policy deletion_log_read on deletion_log for select to authenticated using (workspace_id = my_workspace());

-- Written by the service role only, after the route has checked the signed-in user is a senior of that workspace; there
-- is no insert, update or delete policy on purpose. The workspace reads its own log.
grant select on table public.deletion_log to authenticated;
grant all on table public.deletion_log to service_role;

comment on table deletion_log is
  'Who deleted which candidate or document, and when (item 24 follow-up). Written by the service role before the delete runs. No personal data about the deleted person.';

-- After applying, ask the API to re-read the schema, or the app will keep being told the table is not there:
--   notify pgrst, 'reload schema';
