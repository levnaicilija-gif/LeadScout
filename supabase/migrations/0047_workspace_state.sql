-- 0047 — activity moves off the rows that are about to become everybody's. Item 20 step 2a.
--
-- A record being shared shares only its FACTS. Confirm, Pursue, Not-for-us, notes and job
-- descriptions are one workspace's activity, and leaving them on `leads` and `companies` when those
-- become shared at step 3 would tell every customer what every other customer is working on.
--
-- THIS MIGRATION ONLY CREATES AND COPIES. The app still reads the old columns; 2b switches it over,
-- and a LATER migration drops them. Splitting it that way means a failed verification leaves the
-- originals untouched rather than needing a restore — the same reason the storage-path migration
-- copied before it removed.
--
-- WHAT IS ACTUALLY THERE, measured 2026-09-24 before a line of this was written, because the design
-- is from 2026-09-15 and assumed more: 6 of 221 leads have a status other than 'new' (1 pursue, 5
-- not_for_us), 8 have a confirmation, 2 have a job description — and on 5,889 companies, hiring
-- status is set on ZERO and an employer-type override on THREE. So the real move is 16 lead rows and
-- 3 company rows, small enough to verify row by row rather than by count.
--
-- companies.rfbt_history IS NOT WHAT THE DESIGN THOUGHT IT WAS, and this is the part worth reading.
-- The design lists it as "relationship history" and moves it to workspace_company_state.notes. All
-- 99 values are descriptions of what the COMPANY DOES — "Engineering & project services (energy)",
-- "Industrial insulation, access, surface protection", "EPC (offshore/energy)" — and 79 of the 99
-- are staffing agencies, with `source` null on every one: a hand-written list of competitors and
-- industrial-services firms. That is a SHARED FACT, not one workspace's private note about dealing
-- with them. Moving it would hide it from every other workspace AND mislabel it. Only the NAME is
-- the problem, and the name is precisely what 20a objects to — the first customer welded into a
-- table every customer uses. So it is RENAMED and stays shared (owner's decision, 2026-09-24).
-- The private relationship history the design imagined does not exist yet: notes are born empty.

-- ---- the rename: shared content, a name that stopped being true ---------------------------------
-- The count is taken before and after and compared, rather than checked against the 99 measured
-- today: a literal stops testing what it claims the moment the data changes, which is the trap this
-- codebase has already recorded once as "Showing 3 of 5".
do $$
declare before_count integer; after_count integer;
begin
  if exists (select 1 from information_schema.columns where table_name = 'companies' and column_name = 'rfbt_history')
     and not exists (select 1 from information_schema.columns where table_name = 'companies' and column_name = 'sector_note') then
    execute 'select count(*) from companies where rfbt_history is not null' into before_count;
    execute 'alter table companies rename column rfbt_history to sector_note';
    execute 'select count(*) from companies where sector_note is not null' into after_count;
    if after_count is distinct from before_count then
      raise exception '0047: the rename did not preserve the content — % row(s) before, % after', before_count, after_count;
    end if;
    raise notice '0047: rfbt_history renamed to sector_note, % row(s) intact', after_count;
  end if;
end $$;

comment on column companies.sector_note is
  'What this company does, in one line — "Industrial insulation, access, surface protection". A SHARED fact, hand-written. Was rfbt_history until 0047, which named the first customer on a table every customer uses and described the content wrongly besides.';

-- ---- one workspace's activity on a lead ---------------------------------------------------------
create table if not exists workspace_lead_state (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  status text,
  confirmed_by uuid references users(id),
  confirmed_at timestamptz,
  notes text,
  job_description text,
  jd_version integer,
  updated_at timestamptz default now(),
  updated_by uuid references users(id),
  primary key (workspace_id, lead_id)
);

-- ---- one workspace's activity on a company ------------------------------------------------------
create table if not exists workspace_company_state (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  hiring_status text,
  hiring_status_at timestamptz,
  hiring_status_by uuid references users(id),
  hiring_confirmed_at timestamptz,
  hiring_confirmed_by uuid references users(id),
  -- A correction of a crawled fact stays PRIVATE (owner's decision, 2026-09-24): it is arguably true
  -- for everyone, but one customer's judgement must not silently rewrite another customer's view.
  employer_type_override text,
  employer_type_set_by uuid references users(id),
  employer_type_set_at timestamptz,
  employer_type_reason text,
  notes text,
  updated_at timestamptz default now(),
  updated_by uuid references users(id),
  primary key (workspace_id, company_id)
);

alter table workspace_lead_state enable row level security;
alter table workspace_company_state enable row level security;

-- EXPLICIT GRANTS, not the automatic ones. From 2026-10-30 Supabase stops giving new tables Data API
-- grants automatically, and a table without them is not merely filtered — the client CANNOT REACH IT
-- AT ALL, however correct its RLS policy is. That failure is silent and looks nothing like a policy
-- bug. Verified on 2026-09-24 that these two DID get the automatic grant (a signed-in user's select
-- is allowed and its insert is refused by RLS rather than by "permission denied"), so this changes
-- nothing today — it is here so a database rebuilt from these migrations after the cutoff behaves
-- the same as the one running now. It is also the pattern this project has used since 0038 and which
-- 0039, 0040 and 0042 all follow; 0047 simply failed to.
grant select, insert, update, delete on workspace_lead_state to authenticated;
grant select, insert, update, delete on workspace_company_state to authenticated;
grant all on workspace_lead_state to service_role;
grant all on workspace_company_state to service_role;

-- The 0041 lesson, not a copy of the USING clause: a WITH CHECK that only tests the writer's own
-- workspace is satisfied by putting your own id on a row pointing at somebody else's parent.
drop policy if exists ws_lead_state on workspace_lead_state;
create policy ws_lead_state on workspace_lead_state for all
  using (workspace_id = my_workspace())
  with check (workspace_id = my_workspace() and lead_id in (select id from leads where workspace_id = my_workspace()));

drop policy if exists ws_company_state on workspace_company_state;
create policy ws_company_state on workspace_company_state for all
  using (workspace_id = my_workspace())
  with check (workspace_id = my_workspace() and company_id in (select id from companies where workspace_id = my_workspace()));

-- ---- copy what is there today -------------------------------------------------------------------
insert into workspace_lead_state (workspace_id, lead_id, status, confirmed_by, confirmed_at, job_description, jd_version, updated_at)
select l.workspace_id, l.id, l.status, l.confirmed_by, l.confirmed_at, l.job_description, l.jd_version, l.updated_at
from leads l
where l.workspace_id is not null
  and (l.status is distinct from 'new' or l.confirmed_by is not null or l.job_description is not null)
on conflict (workspace_id, lead_id) do nothing;

insert into workspace_company_state (workspace_id, company_id, hiring_status, hiring_status_at, hiring_status_by, hiring_confirmed_at, hiring_confirmed_by, employer_type_override, employer_type_set_by, employer_type_set_at, employer_type_reason)
select c.workspace_id, c.id, c.hiring_status, c.hiring_status_at, c.hiring_status_by, c.hiring_confirmed_at, c.hiring_confirmed_by, c.employer_type_override, c.employer_type_set_by, c.employer_type_set_at, c.employer_type_reason
from companies c
where c.workspace_id is not null
  and (c.hiring_status is not null or c.hiring_confirmed_at is not null or c.employer_type_override is not null)
on conflict (workspace_id, company_id) do nothing;

-- ---- and refuse to finish if anything was left behind -------------------------------------------
-- Structural refusal over silent correction, as 0046's backfill does. A row that should have moved
-- and did not is the failure this whole item exists to prevent, and it must not pass quietly.
do $$
declare missed integer;
begin
  select count(*) into missed
  from leads l
  where l.workspace_id is not null
    and (l.status is distinct from 'new' or l.confirmed_by is not null or l.job_description is not null)
    and not exists (select 1 from workspace_lead_state s where s.workspace_id = l.workspace_id and s.lead_id = l.id);
  if missed > 0 then raise exception '0047: % lead(s) carry activity that did not reach workspace_lead_state', missed; end if;

  select count(*) into missed
  from companies c
  where c.workspace_id is not null
    and (c.hiring_status is not null or c.hiring_confirmed_at is not null or c.employer_type_override is not null)
    and not exists (select 1 from workspace_company_state s where s.workspace_id = c.workspace_id and s.company_id = c.id);
  if missed > 0 then raise exception '0047: % company/companies carry activity that did not reach workspace_company_state', missed; end if;

  -- The rename verified itself above. Here we only insist the column arrived, since every later
  -- step reads it by that name and a silently skipped guard would be invisible until then.
  if not exists (select 1 from information_schema.columns where table_name = 'companies' and column_name = 'sector_note') then
    raise exception '0047: companies.sector_note does not exist — the rename guard did not fire';
  end if;
end $$;
