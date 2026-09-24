-- 0048 — the state columns get their real types back, and every lead gets a state row. Item 20 step 2b.
--
-- ============================================================================================
-- PART 1: 0047 DROPPED THREE CONSTRAINTS, AND THIS IS THE PART THAT MATTERS
-- ============================================================================================
--
-- 0047 created the state tables with `text` columns where the source columns are typed. The first
-- attempt at 0048 failed on it — `operator does not exist: lead_status = text` — and the obvious fix
-- was to cast in the comparison. That would have made the migration run and left the hole open.
--
-- The hole, MEASURED on 2026-09-24 rather than argued (a throwaway workspace, one lead, one company):
--
--   column                                           source type            0047 made it   bad value
--   workspace_lead_state.status                      lead_status enum       text           ACCEPTED
--   workspace_company_state.employer_type_override   employer_type enum     text           ACCEPTED
--   workspace_company_state.hiring_status            text + check(3 values) text, no check ACCEPTED
--
-- and in every one of those three rows the SOURCE column refused the same value — 22P02 on the two
-- enums, 23514 on the check. So the state tables accept values the database was built to make
-- impossible.
--
-- WHY THAT IS NOT COSMETIC. 2b dual-writes, state row first and column second, and the column's
-- error is deliberately not read — it is only the copy. So writing status 'pursu' (a plausible typo
-- of 'pursue') leaves the state row reading "pursu" and leads.status still reading "new", and every
-- read now comes from the state row. The lead does not vanish — it is still `not in
-- ('stale','not_for_us')` — it simply stops being counted by Home, by the rail badge and by Today's
-- queue, all of which ask for status = 'new'. Silent, plausible, and permanent once 2c drops the
-- column and takes the enum with it.
--
-- AND NOTHING ELSE IS GUARDING IT: api/lead writes `b.status` straight from the request body with no
-- whitelist at all. The enum was the only check. (api/hiring does validate its three values, so the
-- third row above is the least exposed — but the constraint still belongs on the copy.)
--
-- So the columns are converted to match their sources EXACTLY, rather than being "improved":
-- hiring_status stays text with the same three-value check, because that is what companies.hiring_status
-- is. Verified 2026-09-24 that PostgREST filters an EMBEDDED enum column correctly — companies.employer_type
-- is already an enum and already embedded by Radar, and `eq` returns 2 of 105 while `not.in` returns
-- 89, so both discriminate — which is what the whole read switch depends on.
--
-- Safe to convert: all 14 existing state rows hold valid lead_status values ('new', 'pursue',
-- 'not_for_us'), and all 3 company rows hold 'staffing_agency' with a null hiring_status.

-- ---- status becomes the enum it was copied from --------------------------------------------------
-- Guarded on the CURRENT type, so re-running is a no-op rather than an error.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'workspace_lead_state' and column_name = 'status' and data_type = 'text'
  ) then
    alter table workspace_lead_state alter column status drop default;
    alter table workspace_lead_state alter column status type lead_status using status::lead_status;
    raise notice '0048: workspace_lead_state.status is now lead_status';
  end if;
end $$;

-- A NULL status would be worse than a wrong one. The open-lead filter is `not in ('stale',
-- 'not_for_us')`, and NULL is not `not in` anything — the comparison yields NULL, the row fails the
-- filter, and the lead DISAPPEARS from the table, the counts and every chip. That is reachable
-- today: setLeadState's `confirm` path upserts without a status, so an insert with no state row
-- would write NULL. Mirroring leads.status's own `default 'new'` and then refusing NULL outright
-- closes it structurally instead of relying on the row already existing.
-- Verified 2026-09-24: 0 leads and 0 state rows hold a null status, so NOT NULL adds no exception.
alter table workspace_lead_state alter column status set default 'new';
update workspace_lead_state set status = 'new' where status is null;
alter table workspace_lead_state alter column status set not null;

-- ---- the company's two, the same way ------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'workspace_company_state' and column_name = 'employer_type_override' and data_type = 'text'
  ) then
    alter table workspace_company_state
      alter column employer_type_override type employer_type using employer_type_override::employer_type;
    raise notice '0048: workspace_company_state.employer_type_override is now employer_type';
  end if;
end $$;

-- hiring_status stays TEXT with the same check companies.hiring_status carries, because matching the
-- source is the point — turning it into an enum here would make the copy and the original disagree
-- in the other direction.
do $$
begin
  if not exists (
    select 1 from information_schema.constraint_column_usage u
    join information_schema.table_constraints c on c.constraint_name = u.constraint_name
    where u.table_name = 'workspace_company_state' and u.column_name = 'hiring_status' and c.constraint_type = 'CHECK'
  ) then
    alter table workspace_company_state
      add constraint workspace_company_state_hiring_status_check
      check (hiring_status is null or hiring_status in ('new','pursued','not_for_us'));
    raise notice '0048: workspace_company_state.hiring_status now carries the same check as companies.hiring_status';
  end if;
end $$;

-- ============================================================================================
-- PART 2: A STATE ROW FOR EVERY LEAD, NOT ONLY THE ONES SOMEBODY HAS TOUCHED
-- ============================================================================================
--
-- WHY A SPARSE TABLE COULD NOT WORK. leads.status is not merely read, it is FILTERED IN SQL inside
-- `openLeads` — the one closure the Leads table, both source counts and every chip number pass
-- through. CLAUDE.md already records why that matters: "filtering the rows after the fact would
-- leave the banner counting one set and the table showing another". 0047's state table is sparse (a
-- row means this workspace did something: 14 rows for 221 leads), and a sparse table cannot be
-- inner-joined without dropping the 207 untouched leads, while PostgREST cannot cleanly express
-- "no state row OR status not in (…)".
--
-- THE OPTION THAT WAS REJECTED, recorded so nobody re-derives it. Keeping the table sparse and
-- excluding the marked ids with `.not('id','in',(…))` works today — 5 ids — and breaks at roughly
-- 200, where PostgREST's URL runs out. That is a ceiling that passes every test now and fails on the
-- first customer who tidies their list. Owner's decision 2026-09-24: take the rows instead of the
-- ceiling. A view with coalesce() was also considered and rejected — it is the cleanest of the three
-- but would be the first view in this codebase, and the step that establishes the multi-tenant
-- boundary is not where to try a new pattern.
--
-- THE COST, stated rather than hidden: rows = workspaces × leads. 221 today. At ten workspaces and
-- ten thousand leads it is 100,000 narrow rows, which Postgres does not notice. That IS what
-- per-workspace state costs, and the sparse table was only ever hiding it.
--
-- NOTHING CHANGES SEMANTICALLY. Every backfilled row takes the lead's CURRENT status, so a lead
-- reading 'new' through leads.status still reads 'new' through its state row. 2b switches the app
-- over; a LATER migration drops leads.status — never in the same step, per the hard rule learned
-- when 0047 renamed a column six live sites still named.

insert into workspace_lead_state (workspace_id, lead_id, status)
select l.workspace_id, l.id, coalesce(l.status, 'new')
from leads l
where l.workspace_id is not null
on conflict (workspace_id, lead_id) do nothing;

-- ---- and every lead created from now on gets one too ---------------------------------------------
-- Without this the table is total only until the next crawl inserts a lead, and a missing row would
-- drop that lead out of an inner join — invisible on screen, with nothing raised anywhere. It is the
-- silent-failure shape this whole item keeps running into, so it is closed structurally.
--
-- security definer with a pinned search_path, the 0039 rule: a plain function would run as the
-- caller and be subject to the state table's own policy, which is not what a crawl insert should
-- depend on.
create or replace function public.lead_state_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.workspace_id is not null then
    insert into workspace_lead_state (workspace_id, lead_id, status)
    values (new.workspace_id, new.id, coalesce(new.status, 'new'))
    on conflict (workspace_id, lead_id) do nothing;
  end if;
  return new;
end $$;

revoke all on function public.lead_state_row() from public, anon, authenticated;

drop trigger if exists leads_state_row on leads;
create trigger leads_state_row after insert on leads
  for each row execute function public.lead_state_row();

-- ---- verified positively, not by the absence of an error -----------------------------------------
-- "No error" proves nothing here: the insert above would report success having copied zero rows.
-- So the counts are compared, and every backfilled status is compared to its lead's.
do $$
declare leads_n integer; state_n integer; wrong integer; t text;
begin
  -- The type conversion is asserted FIRST, because everything below it silently depends on the two
  -- sides being comparable — and the first version of this migration failed exactly there.
  select data_type into t from information_schema.columns
    where table_name = 'workspace_lead_state' and column_name = 'status';
  if t is distinct from 'USER-DEFINED' then
    raise exception '0048: workspace_lead_state.status is still %, not the lead_status enum — the conversion guard did not fire', t;
  end if;

  select count(*) into leads_n from leads where workspace_id is not null;
  select count(*) into state_n from workspace_lead_state;
  if state_n < leads_n then
    raise exception '0048: % lead(s) with a workspace but only % state row(s) — the table is not total', leads_n, state_n;
  end if;

  select count(*) into wrong
  from leads l
  where l.workspace_id is not null
    and not exists (select 1 from workspace_lead_state s where s.workspace_id = l.workspace_id and s.lead_id = l.id);
  if wrong > 0 then raise exception '0048: % lead(s) still have no state row', wrong; end if;

  -- Every row must AGREE with the lead it came from, or the switch in 2b would change what a
  -- recruiter sees. The 14 rows 0047 copied are included: they were copied from the same source.
  -- No cast is needed any more — both sides are lead_status, which is the whole point of part 1.
  select count(*) into wrong
  from leads l
  join workspace_lead_state s on s.workspace_id = l.workspace_id and s.lead_id = l.id
  where l.status is distinct from s.status;
  if wrong > 0 then raise exception '0048: % lead(s) disagree with their state row — switching the app over would change what is on screen', wrong; end if;

  raise notice '0048: % lead(s), % state row(s), every status agreeing, types matching their sources', leads_n, state_n;
end $$;
