-- 0049 — the moved columns go. Item 20 step 2c, and the first irreversible step in the whole thread.
--
-- THE ORDER THIS DEPENDS ON, because it is the rule 0047 taught the hard way. Code first, deploy,
-- THEN migrate. b5963d3 removed every write to these columns and every read of them, and was
-- deployed and smoked against production before a line of this was written. 0047 renamed a column in
-- one statement while six live sites still named it and took two crawl jobs down; this is the other
-- way round on purpose.
--
-- WHAT GOES: 13 columns that record what ONE workspace decided, now held in workspace_lead_state and
-- workspace_company_state where they cannot be read by anybody else.
--
--   leads      status, confirmed_by, confirmed_at, job_description, jd_version
--   companies  hiring_status, hiring_status_at, hiring_status_by, hiring_confirmed_at,
--              hiring_confirmed_by, employer_type_override, employer_type_set_by, employer_type_set_at
--
-- WHAT STAYS, AND THIS IS THE ONE TO READ TWICE: companies.employer_type_reason. It looks like it
-- belongs with employer_type_override and it does not. 528 companies carry one and 525 HAVE NO
-- OVERRIDE — the crawl writes it as a shared explanation of the DETECTED type (classify-employers,
-- employer-verdict and find-or-create-company all set it), which is a different fact from the reason
-- a recruiter gives for overriding. Only the override's half ever moved. Dropping it would delete a
-- shared fact and break three crawl paths, and the after-check below refuses if it is missing.
--
-- TWO INDEXES, FOUND BY CHECKING RATHER THAN BY NOTICING LATER (2026-09-24):
--
--   * 0001 created an UNNAMED index on leads (workspace_id, status, fit_score desc) — the one the
--     open-leads query used. Postgres drops it with the column, and workspace_lead_state has NO index
--     but its primary key, while the new hot path filters workspace_id + status. Unmeasurable at 221
--     leads and not at 100,000, which 0048's own comment contemplates. One is added below.
--   * 0012's companies_employer_type_idx is on (workspace_id, employer_type_override, employer_type).
--     Dropping the override takes the WHOLE index, including its coverage of employer_type, which is
--     NOT being dropped and is still read by the agency filter and classify-employers. Its name
--     mentions neither column, which is exactly why it was nearly missed. Recreated below.
--
-- Both are created BEFORE the drop, so no window exists in which neither the old nor the new is there.
--
-- Nothing else depends on these columns: no RLS policy references one, and
-- effective_employer_type(detected, override) takes parameters rather than reading the column and has
-- zero callers outside the migration that created it. It is left alone rather than widening the drop.

-- ============================================================================================
-- 1. THE SNAPSHOT, because this is the step a restore cannot be avoided for
-- ============================================================================================
-- The state tables already hold this data; the snapshot is insurance against THIS MIGRATION being
-- wrong, not against the data being lost. Owner's decision 2026-09-24: cheap, and worth it for the
-- one irreversible step.
--
-- NOT dropped here. It is the owner's to drop once satisfied, which is the point of a backup.
--
-- Service role only, on the 0027/0029 pattern: RLS on plus a policy scoped `to service_role`, so
-- `authenticated` matches no policy and reads nothing. That combination matters — RLS with NO policy
-- at all is what rls_tables_without_policy() reports as a finding, and a backup of one workspace's
-- private activity readable by a signed-in user would reintroduce the leak this whole item closes.
-- The grants are explicit, not inherited: from 2026-10-30 Supabase stops granting new tables Data API
-- access automatically, and this table must never have it anyway.
create table if not exists leads_2c_backup as
  select id, workspace_id, status, confirmed_by, confirmed_at, job_description, jd_version, now() as backed_up_at
  from leads;

create table if not exists companies_2c_backup as
  select id, workspace_id, hiring_status, hiring_status_at, hiring_status_by,
         hiring_confirmed_at, hiring_confirmed_by,
         employer_type_override, employer_type_set_by, employer_type_set_at, now() as backed_up_at
  from companies;

alter table leads_2c_backup enable row level security;
alter table companies_2c_backup enable row level security;

drop policy if exists leads_2c_backup_service_role_only on leads_2c_backup;
create policy leads_2c_backup_service_role_only on leads_2c_backup for all to service_role using (true) with check (true);
drop policy if exists companies_2c_backup_service_role_only on companies_2c_backup;
create policy companies_2c_backup_service_role_only on companies_2c_backup for all to service_role using (true) with check (true);

revoke all on leads_2c_backup from anon, authenticated;
revoke all on companies_2c_backup from anon, authenticated;
grant all on leads_2c_backup to service_role;
grant all on companies_2c_backup to service_role;

comment on table leads_2c_backup is
  'Item 20 step 2c (0049): the five per-workspace columns dropped from leads, as they stood at the drop. Insurance against the migration, not a live table — workspace_lead_state is where these live now. Safe to drop once 2c is settled.';
comment on table companies_2c_backup is
  'Item 20 step 2c (0049): the eight per-workspace columns dropped from companies, as they stood at the drop. employer_type_reason is NOT here because it was NOT dropped — it is a shared crawl fact.';

-- Copied, not assumed. `create table as` reports success having copied nothing if the source is empty,
-- and a backup nobody checked is the same as no backup.
do $$
declare src integer; bak integer;
begin
  select count(*) into src from leads;
  select count(*) into bak from leads_2c_backup;
  if bak <> src then raise exception '0049: leads has % row(s) but the backup holds % — refusing to drop anything', src, bak; end if;

  select count(*) into src from companies;
  select count(*) into bak from companies_2c_backup;
  if bak <> src then raise exception '0049: companies has % row(s) but the backup holds % — refusing to drop anything', src, bak; end if;

  raise notice '0049: backups hold every row';
end $$;

-- ============================================================================================
-- 2. jd_version: the copy mirrors its source before the source is compared to it
-- ============================================================================================
-- leads.jd_version is `int default 0`, but 0048's backfill inserted only (workspace_id, lead_id,
-- status), so the 207 leads 0047 had not already copied hold NULL where the column holds 0. Measured
-- 2026-09-24: that is the ONLY field that disagrees — status, confirmed_by, confirmed_at and
-- job_description match on all 221.
--
-- Harmless today: every reader does `jd_version ?? 0`, two leads have a job description at all, and
-- scores holds zero rows. Fixed anyway, because the equality check below is the thing standing between
-- this migration and a silent loss, and a check with a known-failing field is a check somebody will
-- be tempted to loosen. Mirroring the source is the same rule 0048 applied to status.
update workspace_lead_state s set jd_version = 0
  where s.jd_version is null
    and exists (select 1 from leads l where l.id = s.lead_id and l.jd_version = 0);

alter table workspace_lead_state alter column jd_version set default 0;

-- ============================================================================================
-- 3. THE INDEXES, before the drop rather than after
-- ============================================================================================
-- The new hot path: one workspace's leads by status. Replaces what 0001's unnamed index on
-- leads (workspace_id, status, fit_score desc) gave the query that now joins through here.
create index if not exists workspace_lead_state_status_idx on workspace_lead_state (workspace_id, status);

-- 0012's index covers (workspace_id, employer_type_override, employer_type) and would be dropped
-- WHOLE with the override column, taking employer_type's coverage with it. Dropped and recreated
-- under the SAME name on the two columns that remain, so nothing is ever without it.
drop index if exists companies_employer_type_idx;
create index if not exists companies_employer_type_idx on companies (workspace_id, employer_type);

-- ============================================================================================
-- 4. REFUSE unless every field agrees, per field, with the numbers in the message
-- ============================================================================================
-- Per FIELD, not per row: a row-level check that stops at the first mismatch reports one number and
-- hides the rest, which is how the jd_version gap first read as "207 leads disagree" when four of the
-- five fields were perfect. The message names the field and the count so a failure is actionable
-- rather than a puzzle.
do $$
declare bad integer; total integer;
begin
  select count(*) into total from leads where workspace_id is not null;

  select count(*) into bad from leads l join workspace_lead_state s
    on s.workspace_id = l.workspace_id and s.lead_id = l.id
   where l.status is distinct from s.status;
  if bad > 0 then raise exception '0049: status disagrees on % of % lead(s) — the column is NOT safe to drop', bad, total; end if;

  select count(*) into bad from leads l join workspace_lead_state s
    on s.workspace_id = l.workspace_id and s.lead_id = l.id
   where l.confirmed_by is distinct from s.confirmed_by;
  if bad > 0 then raise exception '0049: confirmed_by disagrees on % of % lead(s)', bad, total; end if;

  select count(*) into bad from leads l join workspace_lead_state s
    on s.workspace_id = l.workspace_id and s.lead_id = l.id
   where l.confirmed_at is distinct from s.confirmed_at;
  if bad > 0 then raise exception '0049: confirmed_at disagrees on % of % lead(s)', bad, total; end if;

  select count(*) into bad from leads l join workspace_lead_state s
    on s.workspace_id = l.workspace_id and s.lead_id = l.id
   where l.job_description is distinct from s.job_description;
  if bad > 0 then raise exception '0049: job_description disagrees on % of % lead(s)', bad, total; end if;

  select count(*) into bad from leads l join workspace_lead_state s
    on s.workspace_id = l.workspace_id and s.lead_id = l.id
   where coalesce(l.jd_version, 0) is distinct from coalesce(s.jd_version, 0);
  if bad > 0 then raise exception '0049: jd_version disagrees on % of % lead(s) even after the backfill', bad, total; end if;

  -- And no lead may be without its row, or dropping the column loses that lead's status outright.
  select count(*) into bad from leads l where l.workspace_id is not null
    and not exists (select 1 from workspace_lead_state s where s.workspace_id = l.workspace_id and s.lead_id = l.id);
  if bad > 0 then raise exception '0049: % lead(s) have no state row — their status would be LOST', bad; end if;

  raise notice '0049: all five lead fields agree across % lead(s)', total;
end $$;

-- The company side. Every company carrying any of these must have a state row holding the same value.
-- Measured 2026-09-24: hiring_status and hiring_confirmed_at are set on ZERO companies and an override
-- on three — so this is small, and a check on an empty set is exactly the kind that passes vacuously.
-- It therefore asserts the three overrides MATCH rather than merely that nothing is missing.
do $$
declare bad integer;
begin
  select count(*) into bad from companies c
   where (c.hiring_status is not null or c.hiring_confirmed_at is not null or c.employer_type_override is not null)
     and not exists (select 1 from workspace_company_state s where s.workspace_id = c.workspace_id and s.company_id = c.id);
  if bad > 0 then raise exception '0049: % company/companies carry state with no state row — it would be LOST', bad; end if;

  select count(*) into bad from companies c
    join workspace_company_state s on s.workspace_id = c.workspace_id and s.company_id = c.id
   where c.hiring_status is distinct from s.hiring_status
      or c.hiring_confirmed_at is distinct from s.hiring_confirmed_at
      or c.employer_type_override is distinct from s.employer_type_override;
  if bad > 0 then raise exception '0049: % company/companies disagree with their state row', bad; end if;

  raise notice '0049: every company with state has a matching state row';
end $$;

-- ============================================================================================
-- 5. THE DROP
-- ============================================================================================
alter table leads
  drop column if exists status,
  drop column if exists confirmed_by,
  drop column if exists confirmed_at,
  drop column if exists job_description,
  drop column if exists jd_version;

alter table companies
  drop column if exists hiring_status,
  drop column if exists hiring_status_at,
  drop column if exists hiring_status_by,
  drop column if exists hiring_confirmed_at,
  drop column if exists hiring_confirmed_by,
  drop column if exists employer_type_override,
  drop column if exists employer_type_set_by,
  drop column if exists employer_type_set_at;

-- ============================================================================================
-- 6. AND SAY SO POSITIVELY
-- ============================================================================================
-- Every dropped column is gone, the one that stays is still there, and the indexes exist. A migration
-- that reported success while leaving a column behind would leave the next reader believing 2c is
-- finished when a stale column is still on the table.
do $$
declare still text;
begin
  select string_agg(table_name || '.' || column_name, ', ') into still
    from information_schema.columns
   where table_schema = 'public'
     and ((table_name = 'leads' and column_name in ('status','confirmed_by','confirmed_at','job_description','jd_version'))
       or (table_name = 'companies' and column_name in ('hiring_status','hiring_status_at','hiring_status_by',
            'hiring_confirmed_at','hiring_confirmed_by','employer_type_override','employer_type_set_by','employer_type_set_at')));
  if still is not null then raise exception '0049: these columns were NOT dropped: %', still; end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'companies' and column_name = 'employer_type_reason') then
    raise exception '0049: companies.employer_type_reason is GONE — it is a shared crawl fact on 525 companies and must not have been dropped';
  end if;

  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'workspace_lead_state_status_idx') then
    raise exception '0049: workspace_lead_state_status_idx was not created — the open-leads query lost its index with leads.status';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'companies_employer_type_idx') then
    raise exception '0049: companies_employer_type_idx was not recreated — employer_type lost its coverage with the override';
  end if;

  raise notice '0049: 13 columns dropped, employer_type_reason kept, both indexes in place';
end $$;
