-- 0051 — a workspace may record state against any lead it can SEE, not only one it owns. Item 20 step 3a.
--
-- THE PROBLEM THIS UNBLOCKS, found by investigating rather than from the design (2026-09-25). 0047 gave
-- both state tables a WITH CHECK keyed on OWNERSHIP:
--
--     with check (workspace_id = my_workspace()
--                 and lead_id in (select id from leads where workspace_id = my_workspace()))
--
-- That was right while leads were private: it is the 0041 lesson, which is that a WITH CHECK testing
-- only the row being written is satisfied by putting your OWN workspace id on a row pointing at
-- somebody else's parent. It has to stay true.
--
-- But the moment leads become shared (step 3c) that clause INVERTS INTO A LOCK. `leads.workspace_id`
-- stops meaning "who may work on this" and starts meaning "who crawled it" — which is RFBT for all 229
-- rows — so every other workspace would be able to read a shared lead and unable to mark it. Not an
-- error either: the insert would simply be refused, one workspace at a time, for a reason nothing on
-- screen could explain. The design never mentions it because the state tables did not exist in 2026-09-15.
--
-- THE FIX IS NOT TO WIDEN THE CHECK. Dropping the parent clause would restore exactly the 0041 hole.
-- The clause is instead expressed against VISIBILITY rather than OWNERSHIP:
--
--     with check (workspace_id = my_workspace() and lead_id in (select id from leads))
--
-- A subquery inside a policy is itself subject to the referenced table's RLS, so `(select id from leads)`
-- means "the leads THIS CALLER CAN SEE" and nothing more. The 0041 property is preserved by
-- construction, and it keeps being preserved when 3c changes what a caller can see — the entitlement
-- function will govern this clause without this policy being touched again. That is the point: one place
-- decides visibility, and writes follow it.
--
-- IT IS A NO-OP TODAY, AND THAT IS WHY IT IS SAFE TO APPLY NOW. `leads` policy is still
-- `workspace_id = my_workspace()`, so the set `(select id from leads)` is today EXACTLY
-- `(select id from leads where workspace_id = my_workspace())`. Same rows, same refusals, no behaviour
-- change for anybody — which also means the probe beside it cannot prove the new semantics DIFFER,
-- because they do not differ yet. It proves the safety property survives and the change is inert;
-- the entitlement behaviour gets its own probe at 3b/3c, where cross-workspace visibility becomes real.
-- Said here rather than implied, because a check that cannot fail is worth nothing and this one is
-- deliberately narrow.
--
-- WHO WRITES THESE TABLES, since the WITH CHECK only applies to some of them: api/lead and
-- api/outreach write state with the SIGNED-IN client, so this clause is live on those paths.
-- api/leads/send-pack, api/hiring and api/company/employer-type use the service role and bypass RLS
-- entirely, and 0048's trigger is security definer, so none of those are affected either way.
--
-- No column is added, renamed or dropped, and no trigger references a column, so the drop-order rule
-- and the new./old. trigger-reference check have nothing to catch here. Policies are replaced in one
-- statement and are reversible in one statement, which is the whole reason 3a goes first.

drop policy if exists ws_lead_state on workspace_lead_state;
create policy ws_lead_state on workspace_lead_state for all
  using (workspace_id = my_workspace())
  with check (workspace_id = my_workspace() and lead_id in (select id from leads));

drop policy if exists ws_company_state on workspace_company_state;
create policy ws_company_state on workspace_company_state for all
  using (workspace_id = my_workspace())
  with check (workspace_id = my_workspace() and company_id in (select id from companies));

comment on table workspace_lead_state is
  'One workspace''s activity on a lead: status, confirmation, notes, job description. Total — every lead has a row (0048) and a trigger keeps it so. Writable for any lead the caller can SEE (0051), so the entitlement function will govern it without this policy changing again.';
comment on table workspace_company_state is
  'One workspace''s activity on a company: hiring status, confirmation, employer-type override, notes. Sparse — a row means somebody did something. Writable for any company the caller can SEE (0051).';

-- ---- verified positively, and the interesting half is what did NOT change ------------------------
-- Both policies must exist with a WITH CHECK, and the row counts must be untouched: this migration
-- rewrites two policies and must not move a single row.
do $$
declare n integer; leads_n integer; state_n integer;
begin
  -- BOTH halves, because either alone is satisfied by 0047's policy and would pass while changing
  -- nothing. The clause must still REFERENCE the parent — dropping that is the 0041 hole — and must no
  -- longer FILTER it by workspace, which is the lock this migration exists to remove. 0047 rendered as
  -- `lead_id IN (SELECT leads.id FROM leads WHERE (leads.workspace_id = my_workspace()))`; 0051 renders
  -- as `lead_id IN (SELECT leads.id FROM leads)`, so the presence of `FROM leads WHERE` is what tells
  -- them apart. The probe beside this migration CANNOT make that distinction — the two policies are
  -- behaviourally identical today — so this block is the only thing that confirms 0051 actually landed.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'workspace_lead_state' and policyname = 'ws_lead_state'
     and with_check is not null and with_check like '%FROM leads%';
  if n <> 1 then raise exception '0051: ws_lead_state does not carry a WITH CHECK referencing leads — the 0041 hole would be open'; end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'workspace_lead_state' and policyname = 'ws_lead_state'
     and with_check like '%FROM leads WHERE%';
  if n <> 0 then raise exception '0051: ws_lead_state still filters leads by workspace — this is 0047''s policy, not 0051''s, and every workspace but the crawl''s would be unable to mark a shared lead'; end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'workspace_company_state' and policyname = 'ws_company_state'
     and with_check is not null and with_check like '%FROM companies%';
  if n <> 1 then raise exception '0051: ws_company_state does not carry a WITH CHECK referencing companies'; end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'workspace_company_state' and policyname = 'ws_company_state'
     and with_check like '%FROM companies WHERE%';
  if n <> 0 then raise exception '0051: ws_company_state still filters companies by workspace — this is 0047''s policy'; end if;

  -- And nothing moved. A policy change that altered data would mean this migration did something it
  -- was not asked to.
  select count(*) into leads_n from leads where workspace_id is not null;
  select count(*) into state_n from workspace_lead_state;
  if state_n <> leads_n then
    raise exception '0051: % lead(s) but % state row(s) — the table stopped being total, which this migration must not have touched', leads_n, state_n;
  end if;

  raise notice '0051: both state policies now key on visibility; % lead(s), % state row(s), nothing moved', leads_n, state_n;
end $$;
