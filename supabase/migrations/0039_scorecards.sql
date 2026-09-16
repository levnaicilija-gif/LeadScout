-- Item 11 part 3: the daily scorecard.
--
-- Two tables, one function and one column. The counts themselves are NOT stored: they are computed
-- on read from the rows that already exist (sends, outreach, verifications, candidates, leads), the
-- way item 19's compound signals are, so a scorecard can never drift from what the data says. What
-- is stored here is only what a person wrote or set: the targets a senior chose, the three lines a
-- recruiter added at the end of the day, and the senior's reply.
--
-- Applied by hand, like every other migration. Until it is, hasScorecards() and hasSendsCreatedAt()
-- keep every screen exactly as it was.

-- When a pack was PREPARED. sends.sent_at is deliberately null for a pack (prepared, not sent —
-- nothing leaves except through /api/outreach), so nothing recorded when it happened and "packs
-- prepared today" could not be counted at all. Existing rows are deliberately NOT backfilled: we do
-- not know when they were prepared, and a guess would put them on a day nobody worked.
alter table sends add column if not exists created_at timestamptz default now();

-- Who is a senior, asked the only way a policy safely can.
--
-- The first draft of this migration left "only a senior sets targets" to the route alone. A
-- signed-in recruiter holds the anon key and can write through PostgREST without going near the
-- route, so the rule was not enforced at all — the same defect 0028 fixed on users, where a policy
-- existed and was still wrong.
--
-- It must be security definer. A plain SQL function reading users runs as the caller and is still
-- subject to RLS, and the policy on users calls my_workspace(), which reads users: that is exactly
-- the cycle 0003 fixed after every RLS-protected read failed with "54001 stack depth limit
-- exceeded" and bounced recruiters back to /login. An inline `exists (select 1 from users ...)`
-- inside a policy would rebuild it. search_path is pinned so definer rights cannot be redirected at
-- another schema's table. This is the first role check in SQL in this codebase: everywhere else,
-- senior-only is enforced in the route, and for a table that decides what people are measured
-- against that was not enough.
create or replace function my_role() returns text
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$ select role from users where id = auth.uid() $$;

revoke execute on function my_role() from public;
grant execute on function my_role() to authenticated, service_role;

-- What a senior expects in a day. One row per workspace, or per person where a senior sets one for
-- them; a null target means "not measured", which is different from a target of zero.
create table if not exists scorecard_targets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,   -- null = the workspace's default
  packs_prepared int, cvs_sent int, outreach_sent int,
  verifications int, leads_confirmed int, candidates_added int,
  set_by uuid references users(id), set_at timestamptz default now(),
  unique (workspace_id, user_id)
);

-- What a person wrote about their own day, and what a senior said back. The counts are not here.
create table if not exists scorecards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  notes text,                                            -- the recruiter's own three lines
  submitted_at timestamptz,
  reply text,                                            -- a senior's answer, in their own words
  replied_by uuid references users(id),
  replied_at timestamptz,
  is_test boolean default false,
  unique (workspace_id, user_id, day)
);

create index if not exists scorecards_day on scorecards (workspace_id, day desc);

alter table scorecard_targets enable row level security;
alter table scorecards enable row level security;

-- Targets: everyone in the workspace may READ what they are measured against — a target nobody can
-- see is not a target — but only a senior may write one, and only into their own workspace. One
-- policy per command, because "for all" cannot say read-widely-write-narrowly.
drop policy if exists scorecard_targets_own_workspace on scorecard_targets;
drop policy if exists scorecard_targets_read on scorecard_targets;
drop policy if exists scorecard_targets_insert on scorecard_targets;
drop policy if exists scorecard_targets_update on scorecard_targets;
drop policy if exists scorecard_targets_delete on scorecard_targets;

create policy scorecard_targets_read on scorecard_targets
  for select using (workspace_id = my_workspace());

create policy scorecard_targets_insert on scorecard_targets
  for insert with check (workspace_id = my_workspace() and my_role() = 'senior');

create policy scorecard_targets_update on scorecard_targets
  for update using (workspace_id = my_workspace() and my_role() = 'senior')
          with check (workspace_id = my_workspace() and my_role() = 'senior');

create policy scorecard_targets_delete on scorecard_targets
  for delete using (workspace_id = my_workspace() and my_role() = 'senior');

-- A person's own day is theirs to write: a recruiter recording what happened needs no senior. The
-- reply column is a senior's and the route is what writes it; the workspace boundary here is the
-- security boundary, as it is on every other table.
drop policy if exists scorecards_own_workspace on scorecards;
create policy scorecards_own_workspace on scorecards
  for all using (workspace_id = my_workspace()) with check (workspace_id = my_workspace());

grant select, insert, update, delete on scorecard_targets to authenticated;
grant select, insert, update, delete on scorecards to authenticated;
grant all on scorecard_targets to service_role;
grant all on scorecards to service_role;
